async function fetchData(): Promise<string> {
    console.log("fetchData start");
    await new Promise((r) => setTimeout(r, 500));
    console.log("fetchData end");
    return "data";
}

async function main() {
    console.log(" main 1");
    await fetchData();
    console.log("main 2");
}

main();
