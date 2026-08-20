const WORK_TASK_SUPERVISOR_EMAIL = "ari@rebattery.io";
const WORK_TASK_DELEGATE_EMAIL = "alex@rebattery.io";

export function buildWorkTaskReadScope(
  assigneeExpression: string,
  userParameter: string,
): string {
  return `(${assigneeExpression} = ${userParameter}::uuid or exists (
    select 1
      from crm_users work_task_viewer
     where work_task_viewer.id = ${userParameter}::uuid
       and work_task_viewer.is_active
       and lower(work_task_viewer.email) = '${WORK_TASK_SUPERVISOR_EMAIL}'
       and exists (
         select 1
           from crm_users visible_assignee
          where visible_assignee.id = ${assigneeExpression}
            and visible_assignee.is_active
            and lower(visible_assignee.email) in (
              '${WORK_TASK_SUPERVISOR_EMAIL}',
              '${WORK_TASK_DELEGATE_EMAIL}'
            )
       )
  ))`;
}
