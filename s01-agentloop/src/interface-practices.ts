interface Tool {
    name: string,
    description: string,
    inputSchema: {
        type: "object"
    }
}

const t1: Tool = { name: "bash", description: "run", inputSchema: { type: "object" } };
//const t2: Tool = { name: "bash", inputSchema: { type: "object" } }; 
//const t3: Tool = { name: "bash", description: "run", inputSchema: { type: "string" } };
//const t4: Tool = { name: "bash", description: "run", inputSchema: { type: "object" }, extra: 1 }; 