import { useEffect, useState } from 'react';
import './FogLoading.css';

type Phase = 'placeholder' | 'condensing' | 'content';

/**
 * P1-09: fog loading/condensing wrapper. While `loading` it shows its own
 * blurred, slightly scattered skeleton; when loading flips to false the REAL
 * children render and condense from gaussian blur (blur 15px → 0px, ~0.7s).
 * Every async surface in fog themes wraps its content with this component
 * (session switch, history load, first sidebar load).
 */
export function FogLoading({
  loading,
  children,
}: {
  loading: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>(() => (loading ? 'placeholder' : 'content'));

  useEffect(() => {
    if (!loading && phase === 'placeholder') {
      // Content is ready — swap to the real children and condense once.
      setPhase('condensing');
      const timer = window.setTimeout(() => {
        setPhase('content');
      }, 800);
      return () => {
        window.clearTimeout(timer);
      };
    }
    if (loading && phase !== 'placeholder') {
      setPhase('placeholder');
    }
  }, [loading, phase]);

  if (phase === 'placeholder') {
    return (
      <div className="fog-loading" data-phase="placeholder" aria-hidden="true">
        <div className="fog-loading-skeleton">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <span
              key={index}
              className="fog-loading-skeleton-bar"
              style={{ width: `${String(52 + ((index * 11) % 42))}%` }}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="fog-loading" data-phase={phase}>
      {children}
    </div>
  );
}
