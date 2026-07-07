import { describe, expect, it } from 'vitest';
import { COPILOT_COMMANDS, getQuickCommands, recommendCommands } from './copilotCommands';

describe('copilotCommands', () => {
  it('registers core quick commands', () => {
    expect(getQuickCommands().map((command) => command.id)).toEqual([
      'computer_use',
      'page_diagnosis',
      'document_qa',
      'document_status',
    ]);
  });

  it('keeps every command renderable and categorized', () => {
    for (const command of COPILOT_COMMANDS) {
      expect(command.title).toBeTruthy();
      expect(command.description).toBeTruthy();
      expect(command.requiredContext).toContain('auth');
      expect(command.riskLevel).toMatch(/^(low|medium|high)$/);
    }
  });

  it('recommends commands from page and document hints', () => {
    const commands = recommendCommands({
      hasAttachedFiles: true,
      hasDocuments: true,
      pageHasErrors: true,
      pageHasTables: true,
    }).map((command) => command.id);

    expect(commands).toContain('page_diagnosis');
    expect(commands).toContain('document_qa');
    expect(commands).toContain('ocr');
    expect(commands).toContain('extract_table');
    expect(commands).toContain('computer_use');
  });
});
