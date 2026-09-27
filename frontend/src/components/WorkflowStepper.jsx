const STEPS = ['Upload', 'Understand', 'Profile', 'Intelligence', 'Results', 'Investigate', 'Export'];

/**
 * Maps real dataset/run state onto the 7-stage product lifecycle. This is
 * a visual summary of state that already exists elsewhere (file list,
 * analysis run status) -- it never invents progress that hasn't happened.
 */
export default function WorkflowStepper({ hasFiles, activeRun, hasCompletedRun }) {
  let activeIndex = 0;
  if (hasFiles) activeIndex = 1;
  if (activeRun) {
    const stage = (activeRun.current_stage || '').toLowerCase();
    if (['profiling'].includes(stage)) activeIndex = 2;
    else if (['normalizing', 'analyzing', 'matching', 'generating insights'].includes(stage)) activeIndex = 3;
    else if (activeRun.status === 'complete') activeIndex = 4;
    else if (activeRun.status === 'queued' || stage === 'validating') activeIndex = 1;
  } else if (hasCompletedRun) {
    activeIndex = 4;
  }

  return (
    <div className="workflow-stepper">
      {STEPS.map((step, i) => (
        <div key={step} className={`workflow-step ${i < activeIndex ? 'done' : i === activeIndex ? 'active' : ''}`}>
          <div className="workflow-step-dot">{i < activeIndex ? '✓' : i + 1}</div>
          <div className="workflow-step-label">{step}</div>
          {i < STEPS.length - 1 && <div className="workflow-step-connector" />}
        </div>
      ))}
    </div>
  );
}
