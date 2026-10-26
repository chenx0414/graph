
















import './setup.ts';




import type { ResourceSettings } from "./resource-library-entries.tsx";


import { useResourceLibraryState } from "./resource-library-state.tsx";
import { ResourceLibraryView } from "./resource-library-view.tsx";
import './resource-library.css';

export function ResourceLibrary(props: { settings: ResourceSettings | null; section?: string | undefined }) {
const state = useResourceLibraryState(props);
if (state.fallback !== null) return state.fallback;
return <ResourceLibraryView {...state} />;
}
