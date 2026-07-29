import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import TaskWindow from "./TaskWindow";
import { parseTaskParam } from "./route";

// `index.html?task=<id>` = janela destacada; sem isso, o hub.
const taskId = parseTaskParam(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {taskId ? <TaskWindow taskId={taskId} /> : <App />}
  </React.StrictMode>,
);
