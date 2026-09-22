import { memo, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { messageLink } from '../message-links';

const PLUGINS = [remarkGfm];

/** Local links are preview actions, never browser navigation. @author coolonion */
export default memo(function MessageMarkdownBody({ text, cwd, onOpenFile }: {
  text: string; cwd?: string; onOpenFile?: (path: string) => void;
}) {
  const components = useMemo<Components>(() => ({
    // A rejected image URL must not become src="" and request the chat page.
    img: ({ node: _node, src, ...props }) => src ? <img {...props} src={src} /> : <span>{props.alt}</span>,
    a: ({ href, children }) => {
      const link = messageLink(href, cwd);
      if (link.kind === 'file') return <button type="button" className="message-file-link"
        title={link.path} disabled={!onOpenFile} onClick={() => onOpenFile?.(link.path)}>{children}</button>;
      if (link.kind === 'web') return <a href={link.href} target="_blank" rel="noopener noreferrer">{children}</a>;
      if (link.kind === 'anchor') return <a href={link.href}>{children}</a>;
      return <span>{children}</span>;
    },
  }), [cwd, onOpenFile]);
  // Retain react-markdown's default URL sanitizer, including image URLs.
  return <Markdown remarkPlugins={PLUGINS} components={components}>{text}</Markdown>;
});
