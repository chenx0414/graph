import { expect, test } from 'vitest';
import { drawerWindowBounds } from '../../desktop/drawer-window.ts';
const base={x:100,y:50,width:1000,height:800};
test('drawer preserves content width and stays on its display',()=>{
 expect(drawerWindowBounds(base,{x:0,y:0,width:1800,height:1000},440,false)).toEqual({bounds:{...base,width:1440},expanded:true});
 expect(drawerWindowBounds({...base,x:600},{x:0,y:0,width:1800,height:1000},440,false).bounds.x).toBe(360);
 expect(drawerWindowBounds(base,{x:0,y:0,width:1300,height:1000},440,false)).toEqual({bounds:base,expanded:false});
 expect(drawerWindowBounds(base,{x:0,y:0,width:2000,height:1000},440,true).expanded).toBe(false);
});
