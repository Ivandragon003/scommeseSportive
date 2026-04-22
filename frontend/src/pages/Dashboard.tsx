import React from 'react';
import DashboardPageView from '../components/dashboard/DashboardPageView';

interface DashboardProps {
  activeUser: string;
}

const Dashboard: React.FC<DashboardProps> = (props) => <DashboardPageView {...props} />;

export default Dashboard;
