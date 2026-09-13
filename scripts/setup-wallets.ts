import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Keypair } from "@solana/web3.js";
const names = ["buyer", "gateway", "agent-a", "agent-b"] as const;
await mkdir(".secrets", { recursive: true, mode: 0o700 });
const wallets: Record<string, Keypair> = {};
for (const name of names) {
  const path = `.secrets/${name}.json`;
  try {
    wallets[name] = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await readFile(path, "utf8"))),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    wallets[name] = Keypair.generate();
    await writeFile(path, JSON.stringify([...wallets[name].secretKey]), {
      flag: "wx",
      mode: 0o600,
    });
  }
}
const secrets = {
  GATEWAY_PRIVATE_KEY: JSON.stringify([...wallets.gateway.secretKey]),
  AGENT_A_PRIVATE_KEY: JSON.stringify([...wallets["agent-a"].secretKey]),
  AGENT_B_PRIVATE_KEY: JSON.stringify([...wallets["agent-b"].secretKey]),
};
await writeFile(".secrets/worker-secrets.json", JSON.stringify(secrets), {
  mode: 0o600,
});
try {
  await writeFile(
    ".dev.vars",
    Object.entries(secrets)
      .map(([key, value]) => `${key}='${value}'`)
      .join("\n") + '\nPAYMENT_MODE="demo"\n',
    { flag: "wx", mode: 0o600 },
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
await writeFile(
  ".secrets/addresses.json",
  JSON.stringify(
    Object.fromEntries(
      names.map((name) => [name, wallets[name].publicKey.toBase58()]),
    ),
    null,
    2,
  ),
);
console.log(
  "Wallets ready; private keys are ignored by git. Public devnet addresses:",
);
for (const name of names)
  console.log(`${name}: ${wallets[name].publicKey.toBase58()}`);
