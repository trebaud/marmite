import { useEffect, useState } from 'react';

interface HealthStatus {
  ok: boolean | null;
  error: string | null;
}

function App() {
  const [health, setHealth] = useState<HealthStatus>({ ok: null, error: null });

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data: { ok: boolean }) => setHealth({ ok: data.ok, error: null }))
      .catch((err: unknown) =>
        setHealth({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
  }, []);

  return (
    <div>
      <h1>TodoApp</h1>
      <p>
        API health:{' '}
        {health.ok === null
          ? 'checking…'
          : health.ok
            ? '✅ ok'
            : `❌ ${health.error ?? 'failed'}`}
      </p>
    </div>
  );
}

export default App;
