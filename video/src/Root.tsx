import { Composition } from 'remotion';
import { Orchestration, FPS, DURATION } from './Orchestration';

export const Root: React.FC = () => (
  <Composition
    id="Orchestration"
    component={Orchestration}
    durationInFrames={DURATION}
    fps={FPS}
    width={1280}
    height={720}
  />
);
