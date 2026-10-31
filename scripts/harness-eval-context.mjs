import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createReadStream,constants,existsSync} from 'node:fs';
import {mkdir,readdir,lstat,readlink,symlink,copyFile,chmod,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {join,resolve,relative,dirname,isAbsolute,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CapabilityLibrary} from './lib/capability-library.ts';

const execute=promisify(execFile);
async function tar(args){return execute('tar',args,{env:{...process.env,COPYFILE_DISABLE:'1'},maxBuffer:64*1024*1024});}
async function validateArchive(path){
 const {stdout}=await tar(['-tzf',path]);
 for(const name of stdout.split('\n').filter(Boolean)){
  const segments=name.replace(/\/$/,'').split('/');
  if(isAbsolute(name) || segments.includes('..') || !parts.includes(segments[0]))throw new Error('Evaluation context archive contains an unsafe path');
 }
}
const parts=['agent-combinations.json','capabilities','prompts','extensions'];
const inside=(root,path)=>{const value=relative(root,path);return value==='' || (value!=='..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));};
const recipeFacts=library=>library.recipes.map(({id,resources,resolved})=>({id,resources,resolved}));
const capabilityFacts=library=>library.capabilities.map(({id,version,kind,status,base})=>({id,version,kind,status,...(base?{base:true}:{})}));
async function fileDigest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function inventory(root){
 const entries=[];
 async function walk(path){
  const stat=await lstat(path);const name=relative(root,path);
  if(stat.isDirectory()){
   entries.push([name,'directory']);
   for(const child of (await readdir(path)).sort())await walk(join(path,child));
  }else if(stat.isSymbolicLink()){
   const link=await readlink(path),target=resolve(dirname(path),link);
   if(inside(root,target))entries.push([name,'link',relative(root,target)]);
   else if(!existsSync(target))entries.push([name,'dangling-external-link',link]);
   else throw new Error(`Cannot freeze external symlink: ${name}`);
  }else if(stat.isFile())entries.push([name,'file',stat.mode&0o111,stat.size,await fileDigest(path)]);
  else throw new Error(`Unsupported context entry: ${name}`);
 }
 for(const part of parts){const path=join(root,part);if(existsSync(path))await walk(path);}
 return {sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),entries};
}
async function copyContext(source,target){
 async function copy(path,destination){
  const stat=await lstat(path);
  if(stat.isDirectory()){
   await mkdir(destination,{recursive:true,mode:0o700});
   for(const name of (await readdir(path)).sort())await copy(join(path,name),join(destination,name));
  }else if(stat.isSymbolicLink()){
   const link=await readlink(path),linkTarget=resolve(dirname(path),link);
   if(inside(source,linkTarget))await symlink(relative(dirname(destination),join(target,relative(source,linkTarget))),destination);
   else if(!existsSync(linkTarget))await symlink(link,destination);
   else throw new Error(`Cannot freeze external symlink: ${relative(source,path)}`);
  }else if(stat.isFile()){
   await copyFile(path,destination,constants.COPYFILE_FICLONE|constants.COPYFILE_EXCL);
   await chmod(destination,stat.mode&0o777);
  }else throw new Error('Unsupported context entry');
 }
 await mkdir(target,{recursive:true,mode:0o700});
 for(const part of parts){const path=join(source,part);if(existsSync(path))await copy(path,join(target,part));}
}
async function validatedLibrary(root){
 const library=new CapabilityLibrary({capabilityRoot:join(root,'capabilities'),recipesPath:join(root,'agent-combinations.json')});
 await library.refresh();
 if(library.agentCombinationError())throw new Error('Cannot read source recipes');
 const recipes=library.agentCombinations();
 if(!recipes.some(recipe=>recipe.id==='main'))throw new Error('Source context has no main recipe');
 for(const recipe of recipes){if(recipe.status!=='valid')throw new Error(`Invalid recipe ${recipe.id}: ${recipe.issues.join('; ')}`);library.compileAgentCombination(recipe.id);}
 if(library.capabilities().some(record=>(record.origin??'library')!=='library'))throw new Error('Native/global/agent skills need an explicit snapshot; refusing to omit them');
 return {recipes,capabilities:library.capabilities()};
}
export async function createEvaluationContext(sourceHome,destination){
 const source=await realpath(sourceHome),output=join(await realpath(dirname(resolve(destination))),basename(resolve(destination)));
 if(inside(source,output) || inside(output,source))throw new Error('Source and snapshot directories must be disjoint');
 const library=await validatedLibrary(source);
 const before=await inventory(source);
 await mkdir(output,{mode:0o700});
 const graphHome=join(output,'graph');await copyContext(source,graphHome);
 const copied=await inventory(graphHome),after=await inventory(source);
 if(before.sha256!==after.sha256 || before.sha256!==copied.sha256)throw new Error('Context changed while being copied');
 const installed=await validatedLibrary(graphHome);
 if(JSON.stringify(recipeFacts(installed))!==JSON.stringify(recipeFacts(library)) || JSON.stringify(capabilityFacts(installed))!==JSON.stringify(capabilityFacts(library)))throw new Error('Copied catalog does not match source');
 const archive=join(output,'context.tar.gz');
 // The archive is written with the default gzip level. A lower level measured
 // no faster here (bsdtar archives through libarchive, which ignores the GZIP
 // variable), so the level is left alone rather than claimed as an
 // optimisation.
 await tar(['-czf',archive,'--no-xattrs','-C',graphHome,...parts.filter(part=>existsSync(join(graphHome,part)))]);
 await chmod(archive,0o600);
 await validateArchive(archive);
 if((await inventory(graphHome)).sha256!==copied.sha256)throw new Error('Context changed while being archived');
 const manifest={schemaVersion:2,payload:{format:'tar+gzip',file:'context.tar.gz',sha256:await fileDigest(archive)},sourceHome:source,sha256:copied.sha256,fileCount:copied.entries.filter(e=>e[1]==='file').length,
  recipes:recipeFacts(library),capabilities:capabilityFacts(library),
  packageCacheIncluded:existsSync(join(graphHome,'extensions')),runtimeLoaded:false,externalDependencyPolicy:'Local SDK cache is copied when present. Declared source ranges may still resolve updates; commands and services are not claimed runtime-validated.'};
 await writeFile(join(output,'context.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 await rm(graphHome,{recursive:true});
 return manifest;
}
export async function installEvaluationContext(snapshotHome,graphHome){
 const snapshot=await realpath(snapshotHome),source=join(snapshot,'graph');
 const target=join(await realpath(dirname(resolve(graphHome))),basename(resolve(graphHome)));
 if(inside(snapshot,target) || inside(target,snapshot))throw new Error('Snapshot and destination directories must be disjoint');
 const manifest=JSON.parse(await readFile(join(snapshot,'context.json'),'utf8'));
 if(existsSync(target) && (await readdir(target)).length)throw new Error('Evaluation context destination is not empty');
 if(manifest.schemaVersion===2){
  const archive=join(snapshot,'context.tar.gz');
  if(manifest.payload?.format!=='tar+gzip' || manifest.payload.file!=='context.tar.gz' || (await fileDigest(archive))!==manifest.payload.sha256)throw new Error('Evaluation context snapshot is invalid or changed');
  await validateArchive(archive);
  await mkdir(target,{recursive:true,mode:0o700});
  await tar(['-xzpf',archive,'--no-same-owner','--no-xattrs','-C',target]);
 }else if(manifest.schemaVersion===1){
  if((await inventory(source)).sha256!==manifest.sha256)throw new Error('Evaluation context snapshot is invalid or changed');
  await copyContext(source,target);
 }else throw new Error('Evaluation context snapshot is invalid or changed');
 if((await inventory(target)).sha256!==manifest.sha256)throw new Error('Installed evaluation context differs from snapshot');
 const library=await validatedLibrary(target);
 if(JSON.stringify(manifest.recipes)!==JSON.stringify(recipeFacts(library)) || JSON.stringify(manifest.capabilities)!==JSON.stringify(capabilityFacts(library)))throw new Error('Evaluation context metadata differs from snapshot');
 return manifest;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==4){console.error('Usage: node scripts/harness-eval-context.mjs /source/graph-home /new/snapshot-directory');process.exitCode=1;}
 else try{const manifest=await createEvaluationContext(process.argv[2],process.argv[3]);console.log(JSON.stringify({sha256:manifest.sha256,fileCount:manifest.fileCount,recipes:manifest.recipes.map(r=>({id:r.id,resources:r.resources.length})),capabilities:manifest.capabilities.length,packageCacheIncluded:manifest.packageCacheIncluded,runtimeLoaded:false}));}
 catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
