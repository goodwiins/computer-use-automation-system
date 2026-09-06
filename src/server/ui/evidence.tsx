import { useEffect, useRef, useState } from 'react';
import { segment, useRuns, type Run } from './session';

export function EvidenceViewer({ run }: { run: Run }) {
  const { request } = useRuns();
  const [content, setContent] = useState<{ file: string; text?: string; image?: string }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const objectUrl = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  async function view(file: string) {
    const attempt = ++generation.current;
    setLoading(true);
    setError('');
    setContent(undefined);
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = undefined;
    }
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|json|jsonl)$/.test(file))
        throw new Error('Unsupported evidence file');
      const response = await request(`/runs/${segment(run.runId)}/evidence/${segment(file)}`);
      if (file.endsWith('.png')) {
        if (!response.headers.get('Content-Type')?.startsWith('image/png'))
          throw new Error('Expected masked PNG evidence');
        const blob = await response.blob();
        if (attempt !== generation.current) return;
        objectUrl.current = URL.createObjectURL(blob);
        setContent({ file, image: objectUrl.current });
      } else {
        const text = await response.text();
        if (attempt === generation.current) setContent({ file, text });
      }
    } catch (e) {
      if (attempt === generation.current) setError(e instanceof Error ? e.message : 'Evidence unavailable.');
    } finally {
      if (attempt === generation.current) setLoading(false);
    }
  }
  return (
    <div className="evidence">
      <h4>Evidence</h4>
      {!run.evidence.length && <p>No evidence files available.</p>}
      <div className="actions">
        {run.evidence.map((file) => (
          <button key={file} onClick={() => void view(file)}>
            View {file}
          </button>
        ))}
      </div>
      {loading && <p role="status">Loading authenticated evidence…</p>}
      {error && <p role="alert">{error}</p>}
      {content && (
        <div>
          <h4>{content.file === 'log.jsonl' ? 'Recorded events' : content.file}</h4>
          {content.image ? (
            <img src={content.image} alt="Masked run evidence" />
          ) : content.file === 'log.jsonl' ? (
            <ol aria-label="Recorded events">
              {content.text
                ?.split('\n')
                .filter(Boolean)
                .map((event, index) => (
                  <li key={index}>
                    <pre>{event}</pre>
                  </li>
                ))}
            </ol>
          ) : (
            <pre>{content.text}</pre>
          )}
        </div>
      )}
    </div>
  );
}
