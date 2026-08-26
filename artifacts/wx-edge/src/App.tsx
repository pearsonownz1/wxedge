import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import Dashboard from '@/pages/dashboard';
import Live from '@/pages/live';
import Markets from '@/pages/markets';
import ContractDetail from '@/pages/contract-detail';
import Approvals from '@/pages/approvals';
import RainMarkets from '@/pages/rain-markets';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/live" component={Live} />
      <Route path="/markets" component={Markets} />
      <Route path="/markets/:contractId" component={ContractDetail} />
      <Route path="/approvals" component={Approvals} />
      <Route path="/rain" component={RainMarkets} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
