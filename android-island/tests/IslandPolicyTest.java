import dev.agentbridge.island.IslandPolicy;

public class IslandPolicyTest {
    static int checks;
    static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    public static void main(String[] args) {
        check(IslandPolicy.canTest(3, true), "OS3 supported");
        check(!IslandPolicy.canTest(2, true), "OS2 is not island");
        check(!IslandPolicy.canTest(3, false), "device unsupported");
        check(!IslandPolicy.canTest(0, true), "unknown protocol is not supported");
        check(IslandPolicy.clip("审批😀测试", 3).equals("审批😀"), "do not split surrogate pair");
        check(IslandPolicy.clip(null, 4).isEmpty(), "missing label");
        check(IslandPolicy.waitSeconds(2000, 1000) == 1, "expiry boundary");
        check(IslandPolicy.waitSeconds(0, 1000) == 300, "pending without expiry is bounded");
        check(IslandPolicy.waitSeconds(Long.MAX_VALUE, 1000) == 300, "large expiry capped");
        check(IslandPolicy.notificationMinutes(true, 300) == 720, "pending card must outlive five-minute island summary");
        check(IslandPolicy.notificationMinutes(false, 60) == 1, "completion is short lived");
        check(IslandPolicy.notificationMinutes(false, 15) == 1, "processing has native 15s timeout");
        IslandPolicy policy = new IslandPolicy();
        check(policy.running("A", "processing", 1000), "start actual task");
        check(!policy.running("A", "processing", 43201000), "12 hours must end");
        check(!policy.running("A", "processing", 43202000), "do not restart expired task");
        check(!policy.running("A", "complete", 43203000), "completed is not processing");
        check(policy.running("A", "processing", 43204000), "new task allowed");
        check(!policy.running("", "processing", 43205000), "no selected chat");
        check(!policy.running("B", "approval", 43206000), "waiting is not processing");
        check(policy.running("B", "processing", 43207000), "new chat task");
        check(!policy.running("B", "processing", 43206000), "clock reversed must not show live");
        System.out.println("IslandPolicy: " + checks + " checks passed");
    }
}
