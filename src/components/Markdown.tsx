import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createHighlighter, type Highlighter } from 'shiki';
import './Markdown.css';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

let highlighterPromise: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === undefined) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [
        'bash',
        'c',
        'cpp',
        'css',
        'diff',
        'html',
        'java',
        'javascript',
        'json',
        'markdown',
        'python',
        'rust',
        'shell',
        'sql',
        'toml',
        'typescript',
        'yaml',
      ],
    });
  }
  return highlighterPromise;
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function CodeBlock({ code, lang }: { code: string; lang: string | undefined }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const render = async (): Promise<void> => {
      try {
        const highlighter = await getHighlighter();
        if (cancelled) {
          return;
        }
        const theme = currentTheme() === 'dark' ? DARK_THEME : LIGHT_THEME;
        setHtml(
          highlighter.codeToHtml(code, {
            lang: lang ?? 'text',
            theme,
          }),
        );
      } catch {
        if (!cancelled) {
          setHtml(null);
        }
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  if (html === null) {
    return (
      <pre className="codeblock">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="codeblock codeblock-highlighted"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function InlineCode({ text }: { text: string }): React.JSX.Element {
  return <code className="inline-code">{text}</code>;
}

interface MarkdownProps {
  text: string;
}

export function Markdown({ text }: MarkdownProps): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { children, className } = props;
            const match = /language-(\w+)/.exec(className ?? '');
            const text = typeof children === 'string' ? children.replace(/\n$/, '') : '';
            if (match !== null) {
              return <CodeBlock code={text} lang={match[1]} />;
            }
            return <InlineCode text={text} />;
          },
          a(props) {
            const { href, children } = props;
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
