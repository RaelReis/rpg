import { useStore } from '../state/store';

/** Avisos efemeros: erros do servidor, reconexao, confirmacoes. */
export function Notices(): JSX.Element {
  const notices = useStore((s) => s.notices);
  const dismiss = useStore((s) => s.dismissNotice);

  return (
    <div className="notices">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`notice ${notice.level}`}
          onClick={() => dismiss(notice.id)}
          role="status"
        >
          {notice.message}
        </div>
      ))}
    </div>
  );
}
