/** Texts of the attempt details of the debug panel, bundled with the panel that shows them (see `@/i18n/debugAttempt`). */
const debugAttemptEn = {
  debug: {
    attempt: {
      title: "How it was asked",
      tools: "Asked as a function call",
      json: "JSON in the message",
      streaming: "Streaming",
      notStreaming: "Not streaming",
      thinking: "Thinking: {{level}}",
      reasoningParameter: "Level sent as {{parameter}}",
      calledYes: "Function called: yes",
      calledNo: "Function called: no",
      skipped: "Skipped: {{models}} (no tool calls)",
      firstByte: "First byte: {{time}}",
      toolsOnlyOn: "Tools only: on",
      toolsOnlyOff: "Tools only: off",
      limits: "Limits: start {{start}}, silence {{idle}}",
      limitsRaised: "Limits: start {{start}} (raised from {{from}}), silence {{idle}}",
    },
  },
};

export default debugAttemptEn;
