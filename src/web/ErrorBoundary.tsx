import { Component, type ReactNode } from 'react';
import { Button, Card } from './ui.tsx';

/** One page's crash stays that page's crash.
 *
 * Without a boundary a render error unmounts the whole root, and that is what a
 * blank console is: the sidebar, the open tabs and every panel go down with the
 * one page that failed. The boundary keeps the failure where it happened and
 * says what it was, so the next page still works.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(previous: { resetKey?: string }) {
    // Navigating away from the failed page clears it: the next page gets a
    // fresh boundary instead of the last page's error card.
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Card title="这一页没能显示" icon="alert" subtitle="错误被限制在页面内，控制台的其他部分不受影响">
        <p className="card-sub" data-testid="page-error">{this.state.error.message}</p>
        <div className="card-actions">
          <Button onClick={() => this.setState({ error: null })}>重试</Button>
        </div>
      </Card>
    );
  }
}
