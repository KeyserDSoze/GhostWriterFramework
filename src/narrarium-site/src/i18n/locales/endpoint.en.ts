/** Texts of the check of the connection and of the button that reads the models of an endpoint, bundled with the chunks that show them (see `@/i18n/endpoint`). */
const endpointEn = {
  endpoint: {
    check: "Check the connection",
    checkNamed: "Check the connection of {{name}}",
    checking: "Checking the connection…",
    read: "Read the models from the endpoint",
    readNamed: "Read the models from the endpoint of {{name}}",
    details: "Technical details",
    checkDetails: "Technical details of the check",
    why: "the server may be off, the address may be wrong, or CORS may not allow this site; the browser cannot tell which",
    open: "Open this integration",
    fromBrowser: "This checks from your browser, not from the personal server that runs the autopilot.",
    result: {
      ok_one: "Responds in {{ms}} ms · {{count}} model",
      ok_other: "Responds in {{ms}} ms · {{count}} models",
      okEmpty: "Responds in {{ms}} ms, but lists no models. If it is a gateway, start a model there.",
      okNoList: "Responds in {{ms}} ms, but not with a list of models: check that the address is the API base, for example …/v1.",
      error: "Responds with error {{status}}: {{remedy}}",
      unreachable: "Not reachable: {{why}}.",
      failed: "The connection could not be checked.",
    },
    remedy: {
      key: "check the key",
      forbidden: "check the key and what it is allowed to do",
      address: "there is no list of models at this address: check that it ends with /v1",
      wait: "the endpoint is limiting requests: wait a moment and try again",
      busy: "the endpoint is failing or busy: try again in a moment",
      other: "check the address and the key",
    },
  },
};

export default endpointEn;
