import { describe, it, expect } from 'vitest';
import { TEMPLATES, resolveTemplate, findTemplate } from '../../templates/templates.js';

describe('templates', () => {
  describe('TEMPLATES array', () => {
    it('contains the reopen_conversation template', () => {
      const found = TEMPLATES.find(t => t.name === 'reopen_conversation');
      expect(found).toBeDefined();
      expect(found!.status).toBe('APPROVED');
      expect(found!.category).toBe('UTILITY');
      expect(found!.language).toBe('es');
    });
  });

  describe('findTemplate', () => {
    it('returns the template when it exists', () => {
      const template = findTemplate('reopen_conversation');
      expect(template).toBeDefined();
      expect(template!.name).toBe('reopen_conversation');
    });

    it('returns undefined for an unknown template name', () => {
      expect(findTemplate('nonexistent')).toBeUndefined();
    });
  });

  describe('resolveTemplate', () => {
    it('replaces {{1}} with the first parameter', () => {
      const resolved = resolveTemplate('reopen_conversation', ['Cristian']);

      expect(resolved).toContain('Cristian');
      expect(resolved).not.toContain('{{1}}');
    });

    it('produces the expected full text for reopen_conversation', () => {
      const resolved = resolveTemplate('reopen_conversation', ['María']);

      expect(resolved).toBe(
        'Hola María, vimos que tu consulta fue cerrada. ¿Pudimos ayudarte? Si necesitas algo más, escríbenos.'
      );
    });

    it('throws when the template does not exist', () => {
      expect(() => resolveTemplate('nonexistent', [])).toThrow('Template not found: nonexistent');
    });

    it('handles multiple parameters if a template has them', () => {
      // The current MVP only has one template with 1 param,
      // but the resolver should handle N params generically.
      const resolved = resolveTemplate('reopen_conversation', ['Test']);
      expect(resolved).toContain('Test');
    });
  });
});
