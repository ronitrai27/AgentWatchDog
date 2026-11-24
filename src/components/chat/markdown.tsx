import { isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";

function Heading({ children }: { children?: ReactNode }) {
  return <p className="text-[1.07em] font-semibold text-ink">{children}</p>;
}

const COMPONENTS: Components = {
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
  // Only web links, always in a new tab.
  a: ({ href, children }) =>
    /^https?:\/\//.test(href ?? "") ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-2"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  ul: ({ children }) => (
    <ul className="flex list-disc flex-col gap-1 pl-5">{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="flex list-decimal flex-col gap-1 pl-5">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-ink/20 pl-3">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-ink/7 px-1.5 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  pre: ({ children }) => {
    const props = isValidElement<{ className?: string; children?: ReactNode }>(
      children,
    )
      ? children.props
      : {};
    const code = String(props.children ?? "").replace(/\n$/, "");
    const lang = props.className?.match(/language-([\w-]+)/)?.[1] ?? "text";
    return (
      <CodeBlock size="sm">
        <CodeBlockHeader>
          <CodeBlockTitle>{lang}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={code} />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent>{code}</CodeBlockContent>
      </CodeBlock>
    );
  },
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-[0.87em]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-ink/5">{children}</thead>,
  tr: ({ children }) => <tr className="not-first:border-t">{children}</tr>,
  th: ({ children }) => <th className="px-3 py-2 font-medium">{children}</th>,
  td: ({ children }) => (
    <td className="border-t px-3 py-2 align-top">{children}</td>
  ),
};

const PLUGINS = [remarkGfm];

/**
 * What Rox writes, as Markdown. Raw HTML is never rendered, and images are left out so nothing
 * Rox quotes can load from another site.
 */
export function Markdown({
  text,
  className = "text-[15px]",
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-3 leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={PLUGINS}
        components={COMPONENTS}
        disallowedElements={["img"]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
