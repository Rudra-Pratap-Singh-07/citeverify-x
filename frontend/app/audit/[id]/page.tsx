import DualPaneWorkbench from "../../../components/DualPaneWorkbench";
export default function AuditPage({ params }: { params: { id: string } }) {
  return <DualPaneWorkbench key={params.id} id={params.id} />;
}
