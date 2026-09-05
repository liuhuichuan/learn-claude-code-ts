import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync} from "node:fs"

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL, // 可选
});
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

const TOOLS: Anthropic.Messages.Tool[] = [{
  name: "bash",
  description: "Run a shell command.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
},
{
  name: "read_file",
  description: "Read a file content by path",
  input_schema: {
    type: "object",
    properties: {path: {type: "string"}},
    required: ["path"],
  },
}];

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d)))
    return "Error: Dangerous command blocked";
  const r = spawnSync(command, { shell: true, cwd: process.cwd(),
    encoding: "utf8", timeout: 120_000 });
  if (r.error) return `Error: ${r.error.message}`;   // 超时/启动失败
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return out ? out.slice(0, 50_000) : "(no output)";
}

function runReadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8").slice(0, 50_000);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function agentLoop(messages: Anthropic.Messages.MessageParam[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages,
      tools: TOOLS, max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolCalls = response.content.filter(
      (b) => b.type === "tool_use",
    );
    if (toolCalls.length === 0) return;

    const results = toolCalls.map((block) => {
      //const cmd = (block.input as { command?: string }).command ?? ""; // 类型断言
      //console.log(`\x1b[33m$ ${cmd}\x1b[0m`);
      //const output = runBash(cmd);
      const input = block.input as {command?: string; path?: string};
      console.log(`\x1b[33m$ [${block.name}] ${input.command?? input.path ?? ""} \x1b[0m`);

      let output: string;
      if (block.name === "bash") {
        output = runBash(input.command?? "");
      } else if (block.name === "read_file") {
        output = runReadFile(input.path ?? "");
      } else {
        output = `Error: unknown tool ${block.name}`;
      }
      console.log(output.slice(0, 200));
      return {
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: output,
      };
    });

    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });
  const history: Anthropic.Messages.MessageParam[] = [];

  console.log("s01-ts: Agent Loop");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  while (true) {
    const query = await rl.question("\x1b[36ms01 >> \x1b[0m");
    const q = query.trim().toLowerCase();
    if (q === "q" || q === "exit" || q === "") break;

    history.push({ role: "user", content: query });
    await agentLoop(history);

    // 打印模型最终文本回复(对应 Python 版 history[-1])
    const last = history[history.length - 1].content;
    if (typeof last !== "string") {
      for (const b of last) {
        if (b.type === "text") console.log(b.text);
      }
    }
    console.log();
  }
  rl.close();
}

main();