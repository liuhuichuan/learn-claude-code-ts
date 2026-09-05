/**
 * s02 - Tool Use
 *
 * s01 的 agent loop 不变。这一课加上四个文件工具和一个分发 map：
 *
 *   +----------+      +-------+      +--------------------------+
 *   |   User   | ---> |  LLM  | ---> | Tool Dispatch            |
 *   |  prompt  |      |       |      | bash       -> runBash    |
 *   +----------+      +---+---+      | read_file  -> runRead    |
 *                          ^          | write_file -> runWrite   |
 *                          |          | edit_file  -> runEdit    |
 *                          +----------+ glob       -> runGlob    |
 *                             tool_result
 *
 *   + runRead / runWrite / runEdit / runGlob
 *   + TOOL_HANDLERS 分发 map（取代 s01 里的 if/else 硬编码）
 *   + safePath 把文件工具锁在工作区内
 *
 * Key insight: the loop stays the same; only tool registration and dispatch grow.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve, relative, join, dirname, isAbsolute } from "node:path";

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// -- 来自 s01（不变）--

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d)))
    return "Error: Dangerous command blocked";
  const r = spawnSync(command, { shell: true, cwd: WORKDIR, encoding: "utf8", timeout: 120_000 });
  if (r.error) return `Error: ${r.error.message}`; // 超时/启动失败
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return out ? out.slice(0, 50_000) : "(no output)";
}

// -- s02 新增：safe_path 把文件工具锁在工作区内 --

function safePath(p: string): string {
  const abs = resolve(WORKDIR, p);
  const rel = relative(WORKDIR, abs);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Path escapes workspace: ${p}`);
  return abs;
}

// -- s02 新增：四个工具 --

function runRead(path: string, limit?: number): string {
  try {
    let lines = readFileSync(safePath(path), "utf-8").split(/\r?\n/);
    if (limit && limit < lines.length)
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    return lines.join("\n");
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

function runWrite(path: string, content: string): string {
  try {
    const file = safePath(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

function runEdit(path: string, oldText: string, newText: string): string {
  try {
    const file = safePath(path);
    const text = readFileSync(file, "utf-8");
    if (!text.includes(oldText)) return `Error: text not found in ${path}`;
    // JS 的 String.replace 恰好只替换第一次出现，对应 Python 的 replace(..., 1)
    writeFileSync(file, text.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

// glob 段（不含路径分隔符）-> 正则；支持 * ? [abc] [!abc]
function segmentToRegex(seg: string): RegExp {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") re += "[^/\\\\]*";
    else if (c === "?") re += "[^/\\\\]";
    else if (c === "[") {
      const j = seg.indexOf("]", i + 1);
      if (j > i) {
        let cls = seg.slice(i + 1, j);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1); // glob 的 ! 否定 -> 正则的 ^
        re += `[${cls}]`;
        i = j;
      } else re += "\\[";
    } else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

function walkGlob(dir: string, segments: string[], out: string[]): void {
  const [seg, ...rest] = segments;
  if (seg === undefined) {
    out.push(dir); // pattern 走完，命中目录本身
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 读不了的目录直接跳过
  }
  if (seg === "**") {
    walkGlob(dir, rest, out); // ** 匹配零层
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkGlob(p, segments, out); // 或继续深入任意层
      else if (rest.length === 0) out.push(p); // ** 作为最后一段时也命中文件
    }
  } else {
    const re = segmentToRegex(seg);
    for (const e of entries) {
      if (!re.test(e.name)) continue;
      const p = join(dir, e.name);
      if (rest.length === 0) out.push(p);
      else if (e.isDirectory()) walkGlob(p, rest, out);
    }
  }
}

function runGlob(pattern: string): string {
  try {
    const hits: string[] = [];
    walkGlob(WORKDIR, pattern.split(/[/\\]+/), hits);
    // safePath 同款校验：结果必须留在工作区内（如 pattern 含 ../ 时会被这里滤掉）
    const matches = hits
      .filter((p) => {
        const rel = relative(WORKDIR, resolve(p));
        return !(rel.startsWith("..") || isAbsolute(rel));
      })
      .map((p) => relative(WORKDIR, p));
    return matches.length ? matches.join("\n") : "(no matches)";
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

// -- s02 新增：工具定义（s01 一个工具，s02 五个）--

const TOOLS: Anthropic.Messages.Tool[] = [
  {
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
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in a file once.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
];

// -- s02 新增：分发 map（取代 s01 的 if (block.name === ...) 硬编码）--
// 加一个工具 = TOOLS 加一条 + 这里加一行映射。循环不用动。

type ToolHandler = (input: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(String(command ?? "")),
  read_file: ({ path, limit }) =>
    runRead(String(path ?? ""), limit === undefined ? undefined : Number(limit)),
  write_file: ({ path, content }) =>
    runWrite(String(path ?? ""), String(content ?? "")),
  edit_file: ({ path, old_text, new_text }) =>
    runEdit(String(path ?? ""), String(old_text ?? ""), String(new_text ?? "")),
  glob: ({ pattern }) => runGlob(String(pattern ?? "")),
};

// -- agent loop 与 s01 形状完全一致；只有分发那一行变了 --
// s01: output = runBash(input.command)
// s02: output = TOOL_HANDLERS[block.name](block.input)

async function agentLoop(messages: Anthropic.Messages.MessageParam[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    const toolCalls = response.content.filter((b) => b.type === "tool_use");
    if (toolCalls.length === 0) return; // 没有 tool_use = 模型答完了

    const results = toolCalls.map((block) => {
      console.log(`\x1b[33m> ${block.name}\x1b[0m`);
      const handler = TOOL_HANDLERS[block.name];
      const output = handler
        ? handler(block.input as Record<string, unknown>)
        : `Unknown: ${block.name}`;
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

  console.log("s02: Tool Use - four tools added to s01");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms02 >> \x1b[0m");
    } catch {
      break; // stdin 关闭(EOF)或 Ctrl+C —— 对应 Python 版 except (EOFError, KeyboardInterrupt)
    }
    const q = query.trim().toLowerCase();
    if (q === "q" || q === "exit" || q === "") break;

    history.push({ role: "user", content: query });
    await agentLoop(history);

    // 打印模型最终文本回复（对应 Python 版 history[-1]）
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
