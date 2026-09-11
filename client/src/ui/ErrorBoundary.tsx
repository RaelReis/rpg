import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Barreira de erro por painel.
 *
 * Sem isto, uma excecao ao desenhar um unico campo de ficha desmonta a arvore
 * inteira e a pessoa fica com a tela em branco no meio da sessao — foi
 * exatamente o que aconteceu quando um template gravado por uma versao
 * anterior chegou sem uma propriedade nova. O mapa e o resto da interface nao
 * tem culpa disso, e devem continuar de pe.
 */

interface Props {
  children: ReactNode;
  /** Nome da area, para a mensagem dizer o que falhou. */
  area: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.area}] falhou ao renderizar:`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="section">
        <div className="error-box">
          <strong>{this.props.area} nao pode ser exibido.</strong>
          <div className="hint" style={{ marginTop: 6, color: 'inherit' }}>
            {error.message}
          </div>
        </div>
        <button className="btn sm" onClick={() => this.setState({ error: null })}>
          Tentar de novo
        </button>
        <span className="hint">
          O restante da mesa continua funcionando. Se persistir, recarregue a pagina.
        </span>
      </div>
    );
  }
}
