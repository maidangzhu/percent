import Bubble from "./bubble";
import MainWindow from "./MainWindow";

export default function App() {
  const path = window.location.pathname;

  if (path === "/main") {
    return <MainWindow />;
  }

  return <Bubble />;
}
