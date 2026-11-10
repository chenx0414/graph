(() => {
  const token = '__GRAPH_SHELL_TOKEN__';
  const base = '__GRAPH_SHELL_BASE__';
  if (typeof window === 'undefined' || window.graph) return;
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-graph-shell': token },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) throw new Error((await response.text()) || `${path} answered ${response.status}`);
    return response.json();
  };
  window.graph = {
    isDesktop: true,
    async pickDirectory() {
      const answer = await call('/pick-directory');
      return answer.path ?? null;
    },
    openResource(kind) {
      return call('/open-resource', { kind });
    },
    saveSecret(ref, value) {
      return call('/save-secret', { ref, value });
    },
    secretStatus(refs) {
      return call('/secret-status', { refs });
    },
    relaunch() {
      return call('/relaunch');
    },
  };
})();
