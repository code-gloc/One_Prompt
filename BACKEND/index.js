import { GoogleGenAI } from "@google/genai";
import readlineSync from "readline-sync";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import dotenv from "dotenv";

dotenv.config();

const platform = os.platform();
const asyncExecute = promisify(exec);

// Gemini Client 
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Conversation History 
const History = [];

//  Tool: Execute Shell Command 
async function executeCommand({ command }) {
  console.log(`\n⚙️  Running: ${command}`);
  try {
    const { stdout, stderr } = await asyncExecute(command);
    if (stderr) {
      console.log(`⚠️  Stderr: ${stderr}`);``
      return `Error: ${stderr}`;
    }
    console.log(`✅  Done`);
    return `Success: ${stdout || "(no output)"} || Task executed completely`;
  } catch (error) {
    console.log(`❌  Failed: ${error.message}`);
    return `Error: ${error.message}`;
  }
}

// Tool Declaration 
const executeCommandDeclaration = {
  name: "executeCommand",
  description:
    "Execute a single terminal/shell command. A command can be to create a folder, file, write on a file, edit the file or delete the file",
  parameters: {
    type: "OBJECT",
    properties: {
      command: {
        type: "STRING",
        description: 'A single terminal command. Ex: "mkdir calculator"',
      },
    },
    required: ["command"],
  },
};

const availableTools = { executeCommand };

// Retry Helper (handles 429 rate limit) 
async function generateWithRetry(payload, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent(payload);
      return response;
    } catch (error) {
      const is429 =
        error?.status === 429 ||
        error?.message?.includes("429") ||
        error?.message?.includes("RESOURCE_EXHAUSTED");

      if (is429 && attempt < maxRetries) {
        // Try to parse retry delay from error message, else use exponential backoff
        const retryMatch = error?.message?.match(/retryDelay.*?(\d+)s/);
        const waitSeconds = retryMatch
          ? parseInt(retryMatch[1]) + 2
          : Math.min(15 * attempt, 60);

        console.log(
          `\n⏳ Rate limit hit. Waiting ${waitSeconds}s before retry (attempt ${attempt}/${maxRetries})...`
        );
        await new Promise((res) => setTimeout(res, waitSeconds * 1000));
        continue;
      }

      throw error; // Re-throw if not a 429 or out of retries
    }
  }
}

// Agent Loop 
async function runAgent(userProblem) {
  History.push({
    role: "user",
    parts: [{ text: userProblem }],
  });

  while (true) {
    const response = await generateWithRetry({
      model: "gemini-2.5-flash",
      contents: History,
      config: {
        systemInstruction: `You are a Website Builder expert. You create frontend websites by analysing user input.
You have access to a tool that can run any shell or terminal command.

Current user operating system: ${platform}
Give commands compatible with the user's OS.

Your workflow:
1. Analyse the user query to understand what type of website they want
2. Execute commands one by one, step by step using executeCommand tool
3. Follow this order:
   - mkdir "folder-name"          → create project folder
   - touch "folder/index.html"    → create HTML file
   - touch "folder/style.css"     → create CSS file
   - touch "folder/script.js"     → create JS file
   - Use echo + heredoc or printf to write full code into each file

Important rules:
- Always use double quotes around filenames/paths that may have spaces
- Write complete, production-ready code (not placeholder comments)
- Make the website look modern and professional
- After all commands are done, tell the user the folder name and how to open index.html`,

        tools: [
          {
            functionDeclarations: [executeCommandDeclaration],
          },
        ],
      },
    });

    if (response.functionCalls && response.functionCalls.length > 0) {
      const { name, args } = response.functionCalls[0];
      console.log(`\n🤖 AI wants to call: ${name}`);

      const toolFn = availableTools[name];
      const result = await toolFn(args);

      // Add model's function call to history
      History.push({
        role: "model",
        parts: [{ functionCall: response.functionCalls[0] }],
      });

      // Add function result to history
      History.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response: { result },
            },
          },
        ],
      });
    } else {
      // AI is done — no more tool calls
      History.push({
        role: "model",
        parts: [{ text: response.text }],
      });
      console.log("\n─────────────────────────────────");
      console.log("🎉 Done!\n");
      console.log(response.text);
      console.log("─────────────────────────────────\n");
      break;
    }
  }
}


async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "❌ GEMINI_API_KEY not found. Create a .env file with:\nGEMINI_API_KEY=your_key_here"
    );
    process.exit(1);
  }

  console.log("🚀 AI Website Builder");
  console.log('   Type your request, or "exit" to quit\n');

  const userProblem = readlineSync.question("What website do you want? → ");

  if (userProblem.toLowerCase() === "exit") process.exit(0);

  await runAgent(userProblem);
  main(); // Loop for next request
}

main();