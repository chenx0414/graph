

















import './conversation-drawer.css';








import { useConversationPanelState } from "./conversation-state.tsx";
import type { Settings } from "./conversation-types.tsx";
import { ConversationPanelView } from "./conversation-view.tsx";

export function ConversationPanel(props: {
  id: string;
  settings: Settings | null;
  onChanged?: () => void;
  drawerOpen?: boolean;
  onDrawerOpenChange: (open: boolean) => void;
}) {
const state = useConversationPanelState(props);
if (state.fallback !== null) return state.fallback;
return <ConversationPanelView {...state} />;
}
