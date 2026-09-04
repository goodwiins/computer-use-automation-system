import type { CapabilityArtifact } from './schema.js';

export function toToolSchema(artifact: CapabilityArtifact) {
  const parameters = artifact.parameters.filter(p => p.source !== 'server');
  const inputSchema = {
    type: 'object' as const,
    properties: Object.fromEntries(parameters.map(p => [p.name, {
      type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}), ...(p.pattern ? { pattern: p.pattern } : {}),
    }])),
    required: parameters.filter(p => p.required).map(p => p.name), additionalProperties: false,
  };
  return {
    openai: { type: 'function' as const, function: { name: artifact.id, description: artifact.description, parameters: inputSchema } },
    mcp: { name: artifact.id, description: artifact.description, inputSchema,
      _meta: { version: artifact.version, sensitiveParameters: parameters.filter(p => p.sensitive).map(p => p.name), outputs: artifact.outputs } },
  };
}
