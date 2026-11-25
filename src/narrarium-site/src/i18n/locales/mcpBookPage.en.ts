/**
 * Texts of the part of the public /mcp page that describes the MCP of a book on a personal server, bundled with that page (see `@/i18n/mcpBookPage`):
 * the app entry does not carry them. Every sentence here says what the README of `narrarium-server` says (the section "MCP for each book").
 */
const mcpBookPageEn = {
  mcpBookPage: {
    intro: "How assistants reach Narrarium: the MCP of each book on your own server, the local package and the public endpoint.",
    jump: {
      label: "On this page",
    },
    title: "MCP of a book on your personal server",
    lead: "Every book on your personal server can have its own MCP address, /mcp/<name>. An assistant that connects to it can read the book and, only if you allow it, edit it and steer its autopilot, with tools like the Narrarium Copilot's.",
    use: {
      title: "What it is for",
      body: "Work on a book from the assistant you already use: ChatGPT, Claude.ai, Claude Code, Cursor or VS Code. It can read chapters, scenes, canon and the Synopsis and see what the autopilot is doing; with your permission it can also edit the book and steer the autopilot.",
    },
    start: {
      title: "How to switch it on",
      body: "Run your personal server (npx narrarium-server) and put the book on it. Open the book's settings and turn on MCP server for this book: its address appears, ready to copy. It is off for every book until you do. ChatGPT and Claude.ai also need the server to have a public https address.",
      guide: "Guide: MCP server of a book",
      server: "Personal server: MCP for each book",
    },
    permissions: {
      title: "What an assistant may do",
      read: {
        name: "Read the book",
        text: "Chapters, scenes, canon, files, the Synopsis and what the autopilot is doing. It cannot change anything.",
      },
      write: {
        name: "Change the book",
        text: "Create and edit chapters, scenes, canon, files and the Synopsis. Every change is one git commit that you can revert.",
      },
      run: {
        name: "Control the autopilot",
        text: "Pause or resume it, retry a failed step, give it notes and answer its questions. A resumed autopilot spends your AI credits, within the caps you set.",
      },
    },
    access: {
      title: "How an app connects",
      oauth: "ChatGPT and Claude.ai connect by themselves (OAuth): you paste the address of the book, and a page of your own server asks you to allow the app, with a passkey or the admin code.",
      readOnly: "Read only is the default: changing the book and controlling the autopilot stay off until you turn them on.",
      revoke: "The apps connected to each book are listed, and you can revoke any of them.",
      token: "Claude Code, Cursor and VS Code can use a token that you create for each of them, with only the permissions it needs.",
    },
    risk: {
      label: "Risk:",
      text: "A model that reads the book can be talked into using the tools by the text it reads: give write access only to apps you trust; every change is a commit you can undo.",
    },
    tools: {
      intro: "These are all the tools of a book's MCP, generated from the tools of the current version of the personal server: the names and parameters are the ones an assistant sees, and each line summarises the longer description it reads. An assistant sees only the tools of the permissions you gave it.",
      legend: "A * marks a required parameter. The labels are the hints each tool gives assistants: it only reads, it can replace or remove what is there, or it does not overwrite anything.",
    },
    tables: {
      read: "Every connection has this permission: without it an assistant cannot reach the book at all.",
      write: "Only for a connection that is allowed to change the book.",
      run: "Only for a connection that is allowed to control the autopilot.",
    },
    notes: {
      readOnly: "Read-only",
      destructive: "Can replace or remove",
      additive: "Does not overwrite",
    },
    takes: {
      label: "Takes",
      required: "required",
    },
    packages: {
      title: "Local and public MCP",
    },
  },
};

export default mcpBookPageEn;
