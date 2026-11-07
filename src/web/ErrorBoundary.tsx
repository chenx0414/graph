import { Component, type ReactNode } from 'react';
import { Button, Card } from './ui.tsx';

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(previous: { resetKey?: string }) {
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
