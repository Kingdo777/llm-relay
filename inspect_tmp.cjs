const Database = require('better-sqlite3');
const db = new Database('data/relay.db', { readonly: true });
const r = db.prepare("SELECT input FROM logs WHERE id=7336").get();
const obj = JSON.parse(r.input);
process.stdout.write("keys: " + Object.keys(obj).join(", ") + "\n");
process.stdout.write("hasMessages: " + Array.isArray(obj.messages) + "\n");
process.stdout.write("hasInput: " + (Array.isArray(obj.input) || typeof obj.input) + "\n");
if (Array.isArray(obj.input)) {
  process.stdout.write("input array length: " + obj.input.length + "\n");
  const last3 = obj.input.slice(-3);
  for (const item of last3) {
    process.stdout.write("  type: " + item.type + " role: " + item.role + " content: " + JSON.stringify(item.content).slice(0,100) + "\n");
  }
} else if (typeof obj.input === "string") {
  process.stdout.write("input is string, len: " + obj.input.length + "\n");
}
db.close();
