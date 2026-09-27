const STAGES = ['Queued', 'Validating', 'Profiling', 'Normalizing', 'Analyzing', 'Matching', 'Generating Insights', 'Complete'];

export default function ProcessingStages({ currentStage, progressPct, status }) {
  const currentIdx = STAGES.findIndex(s => s.toLowerCase() === (currentStage || '').toLowerCase());
  return (
    <div>
      <div className="stage-track mb-4">
        {STAGES.map((stage, idx) => {
          const isDone = status === 'complete' || idx < currentIdx;
          const isActive = idx === currentIdx && status !== 'complete';
          return (
            <div className="stage-row" key={stage}>
              <div className={`stage-dot ${isDone ? 'done' : isActive ? 'active' : ''}`} />
              <div className={`stage-label ${isDone ? 'done' : isActive ? 'active' : ''}`}>{stage}</div>
            </div>
          );
        })}
      </div>
      <div style={{ background: 'var(--surface-hover)', height: 6, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${progressPct || 0}%`, height: '100%', background: status === 'failed' ? 'var(--sev-critical)' : 'var(--signal)',
          transition: 'width 0.4s ease'
        }} />
      </div>
      <div className="text-tertiary text-sm mt-2">{progressPct || 0}% complete</div>
    </div>
  );
}
