import path from "node:path";
export function safeJoin(root, userPath) {
  const p = path.join(root, userPath);
  if (!p.startsWith(root)) throw new Error("outside root");
  return p;
}
