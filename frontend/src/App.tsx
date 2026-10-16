/**
 * App — route table. Session-scoped pages accept an optional :sessionId
 * param so links from the (future) session list land directly.
 */

import { Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { HomePage } from "./pages/HomePage";
import { CreateSessionPage } from "./pages/CreateSessionPage";
import { FocusSessionPage } from "./pages/FocusSessionPage";
import { SettlementPage } from "./pages/SettlementPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ReviewPage } from "./pages/ReviewPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="create" element={<CreateSessionPage />} />
        <Route path="focus" element={<FocusSessionPage />} />
        <Route path="focus/:sessionId" element={<FocusSessionPage />} />
        <Route path="settlement" element={<SettlementPage />} />
        <Route path="settlement/:sessionId" element={<SettlementPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
