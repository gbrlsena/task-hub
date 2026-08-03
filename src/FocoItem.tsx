import { Reorder, useDragControls } from "framer-motion";

/**
 * Item arrastável do "Meu foco" — alça dedicada + animação de mola.
 *
 * Compartilhado pelo foco do hub (tasks do ClickUp) e pelo da fila de bugs, pra
 * fixar e reordenar funcionarem igual nas duas telas.
 *
 * A mola do framer-motion aqui é deliberada: o design system do projeto proíbe
 * bounce em UI comum, com exceção explícita de interação de arraste físico.
 */
export default function FocoItem({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={id}
      as="div"
      className="foco-item"
      dragListener={false}
      dragControls={controls}
      whileDrag={{ scale: 1.015, zIndex: 5 }}
      transition={{ type: "spring", stiffness: 500, damping: 40 }}
    >
      <button
        className="drag-grip"
        aria-label="arrastar para reordenar"
        onPointerDown={(e) => controls.start(e)}
      >
        ⠿
      </button>
      <div className="foco-item-body">{children}</div>
    </Reorder.Item>
  );
}
