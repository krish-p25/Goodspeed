async function getApiHealth(): Promise<string> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/health`,
      { cache: 'no-store' },
    );
    const data = (await res.json()) as { status: string };
    return data.status;
  } catch {
    return 'unreachable';
  }
}

export default async function Home() {
  const status = await getApiHealth();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="mb-8 text-4xl font-bold">Knowledge Base</h1>
      <div className="flex items-center gap-2 text-lg">
        <span className="text-gray-600">API Status:</span>
        <span
          className={
            status === 'ok' ? 'font-semibold text-green-600' : 'font-semibold text-red-600'
          }
        >
          {status}
        </span>
      </div>
    </main>
  );
}
