import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { Compartment, EditorState, Prec, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';

class Bullet extends WidgetType {
  toDOM() { const span=document.createElement('span'); span.textContent='•'; span.className='md-bullet'; return span; }
  ignoreEvent() { return false; }
}
function decorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const selection = view.state.selection.main;
  const active = (from: number, to: number) => view.hasFocus && selection.from <= to && selection.to >= from;
  syntaxTree(view.state).iterate({ enter(node) {
    const name = node.name;
    const heading = /^ATXHeading([1-6])$/.exec(name);
    const cls = heading ? `md-heading md-h${heading[1]}` : ({ StrongEmphasis: 'md-strong', Emphasis: 'md-em', InlineCode: 'md-code', Strikethrough: 'md-strike', Link: 'md-link', Blockquote: 'md-quote', FencedCode: 'md-fence' } as Record<string,string>)[name];
    if (cls) ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to));
    if (['HeaderMark', 'EmphasisMark', 'CodeMark', 'QuoteMark', 'StrikethroughMark', 'LinkMark'].includes(name)) {
      const parent = node.node.parent;
      if (parent && !active(parent.from, parent.to)) ranges.push(Decoration.replace({}).range(node.from, name === 'HeaderMark' && view.state.doc.sliceString(node.to,node.to+1) === ' ' ? node.to+1 : node.to));
    }
    if (name === 'ListMark' && /^[*+-]$/.test(view.state.doc.sliceString(node.from,node.to)) && !active(node.from, node.node.parent?.to ?? node.to)) ranges.push(Decoration.replace({widget:new Bullet()}).range(node.from,node.to));
    if (name === 'URL' && node.node.parent?.name === 'Link' && !active(node.node.parent.from, node.node.parent.to)) ranges.push(Decoration.replace({}).range(node.from,node.to));
  }});
  return Decoration.set(ranges, true);
}
const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorations(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) this.decorations = decorations(update.view); }
}, { decorations: value => value.decorations });

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & { live: boolean; 'data-testid'?: string | undefined; 'data-history'?: string | undefined;  };
export const MarkdownInput = forwardRef<HTMLTextAreaElement, Props>(function MarkdownInput(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const syncing = useRef(false);
  const current = useRef(props); current.current = props;
  const appearance = useRef(new Compartment());
  const attributes = useRef(new Compartment());
  const port = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const event = (native: Event) => new Proxy(native, { get(target, key) {
      if (key === 'currentTarget' || key === 'target') return port.current;
      if (key === 'nativeEvent') return target;
      const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: String(current.current.value ?? ''), extensions: [
      markdown(), EditorView.lineWrapping, keymap.of(defaultKeymap),
      appearance.current.of(current.current.live ? livePreview : []),
      attributes.current.of([placeholder(current.current.placeholder ?? ''), EditorView.contentAttributes.of({ 'data-testid': current.current['data-testid'] ?? '', 'aria-label': current.current['aria-label'] ?? '消息', role:'textbox', 'aria-multiline':'true' })]),
      Prec.highest(EditorView.domEventHandlers({
        keydown(native) { if (native.isComposing || view.composing) return false; current.current.onKeyDown?.(event(native) as never); return native.defaultPrevented; },
        paste(native) { current.current.onPaste?.(event(native) as never); return native.defaultPrevented; },
        contextmenu(native) { current.current.onContextMenu?.(event(native) as never); return native.defaultPrevented; },
      })),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !syncing.current) current.current.onChange?.({ target: port.current, currentTarget: port.current } as never);
        if (update.selectionSet) current.current.onSelect?.({ currentTarget: port.current } as never);
      }),
    ]}) });
    editor.current = view;
    const content = view.contentDOM;
    Object.defineProperties(content, {
      value: { get: () => view.state.doc.toString() },
      selectionStart: { get: () => view.state.selection.main.from },
      selectionEnd: { get: () => view.state.selection.main.to },
      setSelectionRange: { value: (start: number,end: number) => view.dispatch({ selection: { anchor: Math.min(start,view.state.doc.length), head: Math.min(end,view.state.doc.length) } }) },
    });
    port.current = content as unknown as HTMLTextAreaElement;
    if (current.current.autoFocus) view.focus();
    return () => { view.destroy(); editor.current = null; };
  }, []);
  useImperativeHandle(ref, () => port.current!, []);
  useLayoutEffect(() => {
    const view=editor.current; if(!view) return;
    const value=String(props.value ?? '');
    if(view.state.doc.toString()!==value) {
      syncing.current = true;
      try { view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value}}); } finally { syncing.current = false; }
    }
  },[props.value]);
  useLayoutEffect(() => { editor.current?.dispatch({effects:[appearance.current.reconfigure(props.live ? livePreview : []),attributes.current.reconfigure([placeholder(props.placeholder ?? ''),EditorView.contentAttributes.of({'data-testid':props['data-testid'] ?? '', 'data-history':props['data-history'] ?? '', 'aria-label':props['aria-label'] ?? '消息', role:'textbox','aria-multiline':'true'})])]}); }, [props.live,props.placeholder,props['data-history']]);
  return <div className="markdown-input" data-live={props.live} ref={host} />;
});
