// Test-only: a person's own search extension with the same tool name.
export default function (pi) {
  pi.registerTool({
    name: 'web_search', label: 'Own search', description: 'OWN-SEARCH: the person\'s own search tool.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute() { return { content: [{ type: 'text', text: 'own' }], details: undefined }; },
  });
}
