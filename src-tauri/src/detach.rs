//! Janela destacada de uma task: label, inventario das abertas e criacao.
//!
//! "Destacado" nao e um dado persistido — e o conjunto de janelas `task-*`
//! abertas, que o Tauri ja conhece. Um crash nao deixa fantasma na lista.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const PREFIX: &str = "task-";

/// Label da janela destacada de uma task.
pub fn window_label(task_id: &str) -> String {
    format!("{PREFIX}{task_id}")
}

/// Id da task quando o label e de uma janela destacada; None para as outras.
pub fn task_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(PREFIX).filter(|id| !id.is_empty())
}

/// Ids das tasks com janela aberta agora. `skip` tira um label do resultado —
/// o evento `Destroyed` pode disparar antes de a janela sair do mapa.
pub fn detached_ids(app: &AppHandle, skip: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| Some(label.as_str()) != skip)
        .filter_map(|label| task_id_from_label(label).map(str::to_string))
        .collect();
    ids.sort();
    ids
}

/// Empurra a lista atualizada pra todas as janelas.
pub fn emit_detached(app: &AppHandle, skip: Option<&str>) {
    let _ = app.emit("taskhub:detached", detached_ids(app, skip));
}

/// Abre a janela da task; se ja existir, so foca (nunca duas pra mesma task).
pub async fn open(app: AppHandle, task_id: String, title: String) -> Result<(), String> {
    let label = window_label(&task_id);

    if let Some(existing) = app.get_webview_window(&label) {
        return existing
            .set_focus()
            .map_err(|e| format!("Nao consegui focar a janela da task: {e}"));
    }

    let url = format!("index.html?task={task_id}");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(460.0, 720.0)
        .min_inner_size(380.0, 400.0)
        .build()
        .map_err(|e| format!("Nao consegui abrir a janela da task: {e}"))?;

    emit_detached(&app, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{task_id_from_label, window_label};

    #[test]
    fn monta_o_label_a_partir_do_id() {
        assert_eq!(window_label("86abc123"), "task-86abc123");
    }

    #[test]
    fn le_o_id_de_volta_do_label() {
        assert_eq!(task_id_from_label("task-86abc123"), Some("86abc123"));
    }

    #[test]
    fn ignora_labels_que_nao_sao_de_task() {
        assert_eq!(task_id_from_label("main"), None);
        assert_eq!(task_id_from_label("task-"), None);
    }
}
