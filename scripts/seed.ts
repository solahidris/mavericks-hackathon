const origin = process.env.GATEWAY_URL || "http://localhost:8787";
for (const kind of ["letters", "sum"]) {
  const endpoint_url = `${origin}/agents/${kind}`;
  const manifest = (await fetch(endpoint_url).then((r) => r.json())) as Record<
    string,
    unknown
  >;
  const response = await fetch(`${origin}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...manifest, endpoint_url }),
  });
  console.log(kind, response.status, await response.text());
  if (!response.ok && response.status !== 409) process.exitCode = 1;
}
export {};
