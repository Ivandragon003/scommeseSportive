import React from 'react';
import { OddsSourceBadgeInfo } from './predictionTypes';

interface OddsSourceBadgeProps {
  badge: OddsSourceBadgeInfo;
  title?: string;
  testId?: string;
}

const OddsSourceBadge: React.FC<OddsSourceBadgeProps> = ({ badge, title, testId }) => (
  <span
    className={`pr-badge ${badge.className}`}
    title={title ?? badge.label}
    aria-label={`Fonte quote: ${badge.label}`}
    data-testid={testId}
  >
    {badge.label}
  </span>
);

export default OddsSourceBadge;
