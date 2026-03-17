/**
 * Hardcoded WhatsApp message templates — identical contract to Meta's template API.
 * For the MVP, only the reopen_conversation template is needed (§6 of spec).
 * Templates bypass the 24-hour messaging window.
 */

export interface TemplateComponent {
  type: 'BODY';
  text: string;
  paramCount: number;
}

export interface Template {
  id: string;
  name: string;
  status: 'APPROVED' | 'REJECTED' | 'PENDING';
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  language: string;
  components: TemplateComponent[];
}

export const TEMPLATES: Template[] = [
  {
    id: 'sim_template_001',
    name: 'reopen_conversation',
    status: 'APPROVED',
    category: 'UTILITY',
    language: 'es',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}, vimos que tu consulta fue cerrada. ¿Pudimos ayudarte? Si necesitas algo más, escríbenos.',
        paramCount: 1,
      },
    ],
  },
];

/** Finds a template by name, or undefined if not found. */
export function findTemplate(name: string): Template | undefined {
  return TEMPLATES.find(t => t.name === name);
}

/**
 * Resolves a template by name, replacing {{N}} placeholders with the given parameters.
 * Throws if the template does not exist.
 */
export function resolveTemplate(name: string, params: string[]): string {
  const template = findTemplate(name);
  if (!template) {
    throw new Error(`Template not found: ${name}`);
  }

  const bodyComponent = template.components.find(c => c.type === 'BODY');
  if (!bodyComponent) {
    throw new Error(`Template ${name} has no BODY component`);
  }

  let body = bodyComponent.text;
  params.forEach((param, index) => {
    body = body.replace(`{{${index + 1}}}`, param);
  });

  return body;
}
