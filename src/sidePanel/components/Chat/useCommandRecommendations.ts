import { useCallback, useMemo, useState } from 'react';
import { recommendCommands } from '../../utils/copilotCommands';
import { collectPageContextHub, type ContextHubExecuteTool } from '../../utils/pageContextHub';

export function useCommandRecommendations(input: {
  executeTool: ContextHubExecuteTool;
  hasAttachedFiles: boolean;
}) {
  const [context, setContext] = useState({
    hasDocuments: false,
    pageHasErrors: false,
    pageHasTables: false,
  });

  const commandIds = useMemo(() => new Set(recommendCommands({
    hasAttachedFiles: input.hasAttachedFiles,
    ...context,
  }).map((command) => command.id)), [context, input.hasAttachedFiles]);

  const refresh = useCallback(async () => {
    try {
      const [pageContext, documents] = await Promise.all([
        collectPageContextHub({
          executeTool: input.executeTool,
          collectConsoleErrors: () => input.executeTool('get_console_errors', { limit: 10, includeContentFallback: true }),
          includeStructuredData: false,
          includeTables: true,
          observeLimit: 120,
        }),
        input.executeTool('list_documents').catch(() => null),
      ]);
      setContext({
        hasDocuments: Array.isArray(documents?.documents) && documents.documents.length > 0,
        pageHasErrors: pageContext.pageSignals.some((signal) => ['console_error', 'resource_error', 'network_error'].includes(signal.type)),
        pageHasTables: pageContext.tableCount > 0 || Boolean(pageContext.tableSummary?.rowCount),
      });
    } catch (error) {
      console.warn('[CommandContext] 读取推荐上下文失败:', error);
    }
  }, [input.executeTool]);

  return { commandIds, refresh };
}
