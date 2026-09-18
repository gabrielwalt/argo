---
name: argo-add-tool
description: Add a new tool to Argo's agent (the bash/read_file/write_file/etc. style tools an Agent frame can call). Use when asked to add a new capability/tool for the Argo agent to invoke.
---

# Adding a new tool to Argo

Three files to touch:

## 1. `src/tools/my-tool.ts`
```typescript
import type { ToolResult } from '../types.js'

export async function myTool(arg: string): Promise<ToolResult> {
  try {
    return { output: '...' }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
```

## 2. `src/tools/index.ts`
- Add import
- Add entry to `toolDefinitions` array (this is what Ollama sees — description quality matters)
- Add case to `executeTool` switch

## 3. `src/types.ts`
- Add `'my_tool'` to the `ToolName` union

tsx watch reloads automatically in `pnpm dev` — no restart needed. Run `argo rebuild` to bake changes into the Docker image.
