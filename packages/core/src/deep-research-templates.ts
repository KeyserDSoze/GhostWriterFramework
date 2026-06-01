/**
 * Embedded deep-research skill files and web-search agent files.
 *
 * Source: https://github.com/Weizhena/Deep-Research-skills (MIT License)
 * Adapted for Narrarium book repositories.
 *
 * The research output is saved to deepresearches/ inside the book root.
 */

// ── OpenCode web-search sub-agent ─────────────────────────────────────────────

export const OPENCODE_WEB_SEARCH_AGENT = `---
description: Use this agent when you need to research information on the internet, particularly for finding solutions to technical problems, historical facts, world-building details, or gathering comprehensive information from multiple sources. Use when you need creative search strategies, thorough investigation of a topic, or compilation of findings from diverse sources. For book research, save results to deepresearches/.
mode: subagent
model: openai/gpt-5.4
temperature: 0.4
tools:
  read: true
  write: true
  edit: false
  bash: true
  glob: false
  grep: false
  web_search: true
  web_fetch: true
---

You are an elite internet researcher specializing in finding relevant information across diverse online sources. Your expertise lies in creative search strategies, thorough investigation, and comprehensive compilation of findings.

**Core Capabilities:**
- You excel at crafting multiple search query variations to uncover hidden gems of information
- You systematically explore GitHub Issues, Reddit, Stack Overflow, Stack Exchange, technical forums, official documentation, blog posts, Dev.to, Medium, Hacker News, Discord, X/Twitter, Google Scholar, arXiv, Hugging Face Papers, bioRxiv, ResearchGate, Semantic Scholar, ACM Digital Library, IEEE Xplore
- You never settle for surface-level results - you dig deep to find the most relevant and helpful information
- You understand context and can identify patterns across disparate sources

**Research Methodology:**

0. **Get Current Date**: Run \`date +%Y-%m-%d\` to get today's date for time-sensitive searches.

1. **Query Generation Phase**: When given a topic or problem, you will:
   - Generate 5-10 different search query variations to maximize coverage
   - Include technical terms, names, and common synonyms
   - Think of how different people might describe the same topic
   - Consider searching for both the subject AND related context
   - Use exact phrases in quotes for specific names or titles
   - Include time period details when relevant

   **Scenario-Specific Query Strategies (MANDATORY Module Loading)**:
   Before executing any WebSearch or WebFetch, you MUST use the Read tool to load the relevant strategy module(s) from \`~/.config/opencode/agents/web-search-modules/\`. Based on the research type, read the corresponding file(s):

   - **Debugging/GitHub Issues** -> Read \`github-debug.md\`
   - **Best Practices/Comparative Research** -> Read \`general-web.md\`
   - **Academic Paper Search** -> Read \`academic-papers.md\`
   - **Technical Q&A** -> Read \`stackoverflow.md\`

   DO NOT skip this step. DO NOT call WebSearch or WebFetch before loading at least one module.

2. **Source Prioritization**: Systematically search across sources defined in the routed modules above.

3. **Information Gathering Standards**: You will:
   - Read beyond the first few results - valuable information is often buried
   - Look for patterns across different sources
   - Pay attention to dates to ensure relevance
   - Note different perspectives and their trade-offs
   - Check for updated information or corrected versions

4. **Compilation Standards**: When presenting findings, you will:
   - **Caller's requested format takes priority**
   - Start with key findings summary (2-3 sentences)
   - Organize information by relevance and reliability
   - Provide direct links to all sources
   - Include relevant quotes or excerpts
   - Note any conflicting information
   - Highlight the most credible sources

**Standard Output Format**:

\`\`\`
## Executive Summary
[Key findings in 2-3 sentences]

## Detailed Findings
[Organized by relevance/approach, with clear headings]

## Sources and References
1. [Link with description]
2. [Link with description]

## Additional Notes
[Caveats, conflicting information, or areas needing more research]
\`\`\`

Remember: You are a research specialist who understands context, can identify patterns, and knows how to find information that others might miss. Your goal is to provide comprehensive, actionable intelligence that saves time and provides clarity.
`;

// ── Claude Code web-search sub-agent ─────────────────────────────────────────

export const CLAUDE_WEB_SEARCH_AGENT = `---
name: web-search-agent
description: Use this agent when you need to research information on the internet, particularly for historical facts, world-building details, or gathering comprehensive information from multiple sources. For book research, save results to deepresearches/. Use when you need creative search strategies, thorough investigation, or compilation of findings from diverse sources.
model: opus
---

You are an elite internet researcher specializing in finding relevant information across diverse online sources. Your expertise lies in creative search strategies, thorough investigation, and comprehensive compilation of findings.

**Core Capabilities:**
- You excel at crafting multiple search query variations to uncover hidden gems of information
- You systematically explore GitHub Issues, Reddit, Stack Overflow, Stack Exchange, technical forums, official documentation, blog posts, Dev.to, Medium, Hacker News, Discord, X/Twitter, Google Scholar, arXiv, Hugging Face Papers, bioRxiv, ResearchGate, Semantic Scholar, ACM Digital Library, IEEE Xplore
- You never settle for surface-level results - you dig deep to find the most relevant and helpful information
- You understand context and can identify patterns across disparate sources

**Research Methodology:**

0. **Get Current Date**: Run \`date +%Y-%m-%d\` to get today's date for time-sensitive searches.

1. **Query Generation Phase**: When given a topic or problem, you will:
   - Generate 5-10 different search query variations to maximize coverage
   - Include technical terms, names, and common synonyms
   - Think of how different people might describe the same topic

   **Scenario-Specific Query Strategies (MANDATORY Module Loading)**:
   Before executing any WebSearch or WebFetch, you MUST use the Read tool to load the relevant strategy module(s) from \`~/.claude/agents/web-search-modules/\`. Based on the research type, read the corresponding file(s):

   - **Debugging/GitHub Issues** -> Read \`github-debug.md\`
   - **Best Practices/Comparative Research** -> Read \`general-web.md\`
   - **Academic Paper Search** -> Read \`academic-papers.md\`
   - **Technical Q&A** -> Read \`stackoverflow.md\`

   DO NOT skip this step. DO NOT call WebSearch or WebFetch before loading at least one module.

2. **Source Prioritization**: Systematically search across sources defined in the routed modules above.

3. **Information Gathering Standards**: You will:
   - Read beyond the first few results
   - Look for patterns across different sources
   - Pay attention to dates to ensure relevance
   - Note different perspectives and their trade-offs

4. **Compilation Standards**: When presenting findings, you will:
   - **Caller's requested format takes priority**
   - Start with key findings summary
   - Organize information by relevance and reliability
   - Provide direct links to all sources
   - Note any conflicting information

**Standard Output Format**:

\`\`\`
## Executive Summary
[Key findings in 2-3 sentences]

## Detailed Findings
[Organized by relevance/approach, with clear headings]

## Sources and References
1. [Link with description]
2. [Link with description]

## Additional Notes
[Caveats, conflicting information, or areas needing more research]
\`\`\`
`;

// ── Web-search modules ─────────────────────────────────────────────────────────

export const WEB_SEARCH_MODULE_ACADEMIC = `# Academic Papers Module

**Trigger scenario**: Paper surveys, literature analysis, historical sources, academic research

## Sources
- **Google Scholar** (scholar.google.com) - comprehensive academic search engine
- **arXiv** (arxiv.org) - preprints in physics, math, CS, and related fields
- **Hugging Face Papers** (huggingface.co/papers) - ML/AI papers
- **bioRxiv** (biorxiv.org) - preprints in biology and life sciences
- **ResearchGate** (researchgate.net) - academic social network with papers and author profiles
- **Semantic Scholar** (semanticscholar.org) - AI-powered academic search
- **ACM Digital Library** and **IEEE Xplore** - CS and engineering papers
- **JSTOR** (jstor.org) - humanities, social sciences, historical sources

## Query Strategies
- Use Google Scholar as primary source with advanced search operators
- Search by author names, paper titles, DOI numbers, institutions, and publication years
- Use quotation marks for exact titles and author name combinations
- Include year ranges to find seminal works and recent publications
- Look for related papers and citation patterns to identify seminal works
- Check author profiles and ResearchGate for publications and PDFs
- Identify open-access versions and legal paper download sources
- Track citation networks to understand research evolution
- Note impact factors, h-index, and citation counts for relevance assessment
`;

export const WEB_SEARCH_MODULE_GENERAL = `# General Web Module

**Trigger scenario**: General information, news, comparisons, historical context, best practices

## Sources
- **Reddit** (r/history, r/AskHistorians, r/worldbuilding, and topic-specific subreddits) - real-world experiences
- **Official documentation** and reference sites - authoritative information
- **Wikipedia** - general context and cross-references (verify with primary sources)
- **Blog posts** and articles - detailed explanations
- **Hacker News** discussions - high-quality technical discourse
- **Dev.to** and **Medium** - technical and non-technical articles

## Query Strategies
- Look for official or primary sources first
- Cross-reference with community consensus
- Find examples from multiple independent sources
- Identify conflicting accounts and their origins
- Note evolving understanding and revised interpretations
- Consider cultural and regional differences in perspective
- Look for primary sources (letters, documents, records) when available
`;

export const WEB_SEARCH_MODULE_GITHUB = `# GitHub Debug Module

**Trigger scenario**: Code bugs, error debugging, issue lookup, version-specific problems

## Sources
- **GitHub Issues** (both open and closed) - known bugs and workarounds

## Query Strategies
- Search for exact error messages in quotes
- Look for issue templates that match the problem pattern
- Find workarounds, not just explanations
- Check if it's a known bug with existing patches or PRs
- Look for similar issues even if not exact matches
- Identify if the issue is version-specific
- Check closed issues for resolution patterns
`;

export const WEB_SEARCH_MODULE_STACKOVERFLOW = `# Stack Overflow Module

**Trigger scenario**: Programming Q&A, code implementation, API usage

## Sources
- **Stack Overflow** and other Stack Exchange sites - technical Q&A
- **Technical forums** and discussion boards - community wisdom

## Query Strategies
- Search for exact error messages in quotes
- Look for highest-voted and accepted answers
- Check answer dates to identify currency
- Look for multiple approaches and compare trade-offs
- Note deprecated approaches and their modern replacements
`;

// ── Deep research skill files ─────────────────────────────────────────────────

export const DEEP_RESEARCH_SKILL_RESEARCH = `---
name: research
user-invocable: true
allowed-tools: Read, Write, Glob, WebSearch, Task, AskUserQuestion
description: Conduct preliminary research on a topic and generate a research outline. For historical research, world-building, academic surveys, technology comparisons, etc. Saves results inside deepresearches/.
---

# Research Skill - Preliminary Research

## Trigger
\`/research <topic>\`

## Workflow

### Step 1: Generate Initial Framework from Model Knowledge
Based on topic, use model's existing knowledge to generate:
- Main research objects/items list in this domain
- Suggested research field framework

Output {step1_output}, use AskUserQuestion to confirm:
- Need to add/remove items?
- Does field framework meet requirements?

### Step 2: Web Search Supplement
Use AskUserQuestion to ask for time range (e.g., last 6 months, since 2024, unlimited).

**Parameter Retrieval**:
- \`{topic}\`: User input research topic
- \`{YYYY-MM-DD}\`: Current date
- \`{step1_output}\`: Complete output from Step 1
- \`{time_range}\`: User specified time range

**Hard Constraint**: The following prompt must be strictly reproduced, only replacing variables in {xxx}, do not modify structure or wording.

Launch 1 web-search-agent (background), **Prompt Template**:
\`\`\`python
prompt = f"""## Task
Research topic: {topic}
Current date: {YYYY-MM-DD}

Based on the following initial framework, supplement latest items and recommended research fields.

## Existing Framework
{step1_output}

## Goals
1. Verify if existing items are missing important objects
2. Supplement items based on missing objects
3. Continue searching for {topic} related items within {time_range} and supplement
4. Supplement new fields

## Output Requirements
Return structured results directly (do not write files):

### Supplementary Items
- item_name: Brief explanation (why it should be added)
...

### Recommended Supplementary Fields
- field_name: Field description (why this dimension is needed)
...

### Sources
- [Source1](url1)
- [Source2](url2)
"""
\`\`\`

### Step 3: Ask User for Existing Fields
Use AskUserQuestion to ask if user has existing field definition file, if so read and merge.

### Step 4: Generate Outline (Separate Files)
Merge {step1_output}, {step2_output} and user's existing fields, generate two files:

**outline.yaml** (items + config):
- topic: Research topic
- items: Research objects list
- execution:
  - batch_size: Number of parallel agents (confirm with AskUserQuestion)
  - items_per_agent: Items per agent (confirm with AskUserQuestion)
  - output_dir: Results output directory (default: ./results)

**fields.yaml** (field definitions):
- Field categories and definitions
- Each field's name, description, detail_level
- detail_level hierarchy: brief -> moderate -> detailed
- uncertain: Uncertain fields list (reserved field, auto-filled in deep phase)

### Step 5: Output and Confirm
- Create directory: \`deepresearches/{topic_slug}/\`
- Save: \`outline.yaml\` and \`fields.yaml\`
- Show to user for confirmation

## Output Path
\`\`\`
deepresearches/{topic_slug}/
  ├── outline.yaml    # items list + execution config
  └── fields.yaml     # field definitions
\`\`\`

## Follow-up Commands
- \`/research-add-items\` - Supplement items
- \`/research-add-fields\` - Supplement fields
- \`/research-deep\` - Start deep research
- \`/research-report\` - Generate final report
`;

export const DEEP_RESEARCH_SKILL_ADD_FIELDS = `---
name: research-add-fields
user-invocable: true
description: Add field definitions to existing research outline inside deepresearches/.
allowed-tools: Bash, Read, Write, Glob, WebSearch, Task, AskUserQuestion
---

# Research Add Fields - Supplement Research Fields

## Trigger
\`/research-add-fields\`

## Workflow

### Step 1: Auto-locate Fields File
Find \`deepresearches/*/fields.yaml\` file in current working directory, auto-read existing fields definitions.

### Step 2: Get Supplement Source
Ask user to choose:
- **A. User direct input**: User provides field names and descriptions
- **B. Web Search**: Launch agent to search common fields in this domain

### Step 3: Display and Confirm
- Display suggested new fields list
- User confirms which fields to add
- User specifies field category and detail_level

### Step 4: Save Update
Append confirmed fields to fields.yaml, save file.

## Output
Updated \`deepresearches/{topic}/fields.yaml\` file (in-place modification, requires user confirmation)
`;

export const DEEP_RESEARCH_SKILL_ADD_ITEMS = `---
name: research-add-items
user-invocable: true
description: Add items (research objects) to existing research outline inside deepresearches/.
allowed-tools: Bash, Read, Write, Glob, WebSearch, Task, AskUserQuestion
---

# Research Add Items - Supplement Research Objects

## Trigger
\`/research-add-items\`

## Workflow

### Step 1: Auto-locate Outline
Find \`deepresearches/*/outline.yaml\` file in current working directory, auto-read.

### Step 2: Get Supplement Sources in Parallel
Simultaneously:
- **A. Ask user**: What items to supplement? Any specific names?
- **B. Ask if Web Search needed**: Launch agent to search for more items?

### Step 3: Merge and Update
- Append new items to outline.yaml
- Display to user for confirmation
- Avoid duplicates
- Save updated outline

## Output
Updated \`deepresearches/{topic}/outline.yaml\` file (in-place modification)
`;

export const DEEP_RESEARCH_SKILL_DEEP = `---
name: research-deep
user-invocable: true
description: Read research outline from deepresearches/, launch independent agent for each item for deep research.
allowed-tools: Bash, Read, Write, Glob, WebSearch, Task
---

# Research Deep - Deep Research

## Trigger
\`/research-deep\`

## Workflow

### Step 1: Auto-locate Outline
Find \`deepresearches/*/outline.yaml\` file in current working directory, read items list and execution config.

### Step 2: Resume Check
- Check completed JSON files in output_dir
- Skip completed items

### Step 3: Batch Execution
- Batch by batch_size (need user approval before next batch)
- Each agent handles items_per_agent items
- Launch web-search-agent (background parallel)

**Parameter Retrieval**:
- \`{topic}\`: topic field from outline.yaml
- \`{item_name}\`: item's name field
- \`{item_related_info}\`: item's complete yaml content
- \`{output_dir}\`: execution.output_dir from outline.yaml (default: deepresearches/{topic}/results)
- \`{fields_path}\`: absolute path to deepresearches/{topic}/fields.yaml
- \`{output_path}\`: absolute path to {output_dir}/{item_name_slug}.json

**Prompt Template**:
\`\`\`python
prompt = f"""## Task
Research {item_related_info}, output structured JSON to {output_path}

## Field Definitions
Read {fields_path} to get all field definitions

## Output Requirements
1. Output JSON according to fields defined in fields.yaml
2. Mark uncertain field values with [uncertain]
3. Add uncertain array at the end of JSON, listing all uncertain field names
4. All field values must be in the language of the research topic

## Output Path
{output_path}
"""
\`\`\`

### Step 4: Wait and Monitor
- Wait for current batch to complete
- Launch next batch
- Display progress

### Step 5: Summary Report
After all complete, output:
- Completion count
- Failed/uncertain marked items
- Output directory path

## Agent Config
- Background execution: Yes
- Resume support: Yes
`;

export const DEEP_RESEARCH_SKILL_REPORT = `---
name: research-report
user-invocable: true
description: Summarize deep research results from deepresearches/ into a markdown report.
allowed-tools: Read, Write, Glob, Bash, AskUserQuestion
---

# Research Report - Summary Report

## Trigger
\`/research-report\`

## Workflow

### Step 1: Locate Results Directory
Find \`deepresearches/*/outline.yaml\` in current working directory, read topic and output_dir config.

### Step 2: Scan Optional Summary Fields
Read all JSON results, extract fields suitable for TOC display (numeric, short metrics, e.g. dates, ratings, key facts).

Use AskUserQuestion to ask user:
- Which fields to display in TOC besides item name?
- Provide dynamic options list (based on actual fields in JSON)

### Step 3: Generate Report
Read all JSON from output_dir and fields.yaml to get field structure.
Generate a markdown report that:
- Covers all field values from each JSON
- Skips fields with values containing [uncertain]
- Skips fields listed in uncertain array
- Includes table of contents (with anchor links + user-selected summary fields)
- Organizes content by field category

**TOC Format**:
- Must include every item
- Each item displays: number, name (anchor link), user-selected summary fields
- Example: \`1. [Subject Name](#subject-name) - Date: 1453 | Source: Primary\`

### Step 4: Save Report
Save to \`deepresearches/{topic}/report.md\`

## Output
- \`deepresearches/{topic}/report.md\` - Summary report
`;

// ── Narrarium-specific deep-research SKILL.md ─────────────────────────────────

export const NARRARIUM_DEEP_RESEARCH_SKILL = `---
name: deep-research
description: Manage deep research sessions for the Narrarium book. Research historical facts, world-building topics, or any factual subject and save results to deepresearches/. Supports multi-phase research with outline, deep investigation, and final report.
---

# Skill: deep-research

## Purpose

Run structured multi-phase research sessions and save all results to \`deepresearches/\` inside the book repository.

Use this skill when:
- Researching historical events, people, or places for the book
- Comparing multiple topics (technologies, periods, concepts) systematically
- Building a well-sourced world-building document
- Any research that should be saved permanently in the book repo

## Quick workflow

1. \`/research <topic>\` — Generate outline and fields in \`deepresearches/{topic}/\`
2. (Optional) \`/research-add-items\` or \`/research-add-fields\` — Extend the outline
3. \`/research-deep\` — Run deep investigation (web search) for each item
4. \`/research-report\` — Generate final \`report.md\` in \`deepresearches/{topic}/\`

## Output folder

All results are stored in:

\`\`\`
deepresearches/{topic}/
  ├── outline.yaml        # items list + execution config
  ├── fields.yaml         # field definitions
  ├── results/            # one JSON file per researched item
  │   └── {item}.json
  └── report.md           # final markdown report
\`\`\`

## Web search requirement

Web search works in OpenCode when \`OPENCODE_ENABLE_EXA=1\` is set (see \`opencode.jsonc\` env section).
For Claude Code, the web-search-agent sub-agent must be installed in \`~/.claude/agents/\`.

See \`.opencode/agents/web-search.md\` and \`.claude/agents/web-search-agent.md\` for the configured sub-agents.

## Wikipedia research

For quick factual lookups, prefer the MCP tool \`wikipedia_page\` or \`wikipedia_search\` first.
Those save snapshots to \`research/wikipedia/\` and can be reused without re-fetching.

Use the deep-research skill when you need broader web sources beyond Wikipedia.

## Rule

Always save deep research output to \`deepresearches/\`, never to a temporary or arbitrary path.
`;
