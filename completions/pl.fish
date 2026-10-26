function __pl_seen_subcommand
    set -l cmd (commandline -opc)
    contains -- run $cmd; or contains -- docker $cmd; or contains -- start $cmd; or contains -- status $cmd; or contains -- stop $cmd; or contains -- restart $cmd; or contains -- logs $cmd; or contains -- backend $cmd; or contains -- help $cmd; or contains -- version $cmd
end

complete -c pl -f -n 'not __pl_seen_subcommand' -a start -d 'Start the saved configuration'
complete -c pl -f -n 'not __pl_seen_subcommand' -a run -d 'Start a Git checkout configuration'
complete -c pl -f -n 'not __pl_seen_subcommand' -a docker -d 'Start a Docker configuration'
complete -c pl -f -n 'not __pl_seen_subcommand' -a status -d 'Show backend and instance status'
complete -c pl -f -n 'not __pl_seen_subcommand' -a stop -d 'Stop the managed instance'
complete -c pl -f -n 'not __pl_seen_subcommand' -a restart -d 'Restart the active or failed instance'
complete -c pl -f -n 'not __pl_seen_subcommand' -a logs -d 'Print or follow lifecycle logs'
complete -c pl -f -n 'not __pl_seen_subcommand' -a backend -d 'Manage the backend supervisor'
complete -c pl -f -n 'not __pl_seen_subcommand' -a help -d 'Show the help message'
complete -c pl -f -n 'not __pl_seen_subcommand' -a version -d 'Show the installed version'
complete -c pl -f -n 'not __pl_seen_subcommand' -s h -l help -d 'Show the help message'
complete -c pl -f -n 'not __pl_seen_subcommand' -s v -l version -d 'Show the installed version'
complete -c pl -f -s q -l quiet -d 'Suppress PrairieLearn launcher output'
complete -c pl -f -l json -d 'Emit JSON output'
complete -c pl -f -l detach -d 'Wait for startup and detach'

complete -c pl -n '__fish_seen_subcommand_from run' -s b -l branch -r -d 'Branch, remote branch, or ref to launch'
complete -c pl -n '__fish_seen_subcommand_from run' -s f -l force-rebuild -d 'Rebuild all dependencies before launch'
complete -c pl -n '__fish_seen_subcommand_from run' -s l -l local-only -d 'Skip git pull before launch'
complete -c pl -n '__fish_seen_subcommand_from run' -s p -l path -r -F -d 'PrairieLearn server checkout path'
complete -c pl -n '__fish_seen_subcommand_from run' -s q -l quiet -d 'Suppress PrairieLearn launcher output'
complete -c pl -n '__fish_seen_subcommand_from run' -s w -l no-watch-upstream -d 'Disable upstream polling and auto-restart'
complete -c pl -n '__fish_seen_subcommand_from run' -l allow-pull-failure -d 'Continue after git pull fails'

complete -c pl -n '__fish_seen_subcommand_from docker' -l port -r -d 'Docker port mapping'
complete -c pl -n '__fish_seen_subcommand_from docker' -l tmp-dir -r -F -d 'Parent directory for temporary Docker jobs directories'
complete -c pl -n '__fish_seen_subcommand_from docker' -s l -l local-only -d 'Use the local Docker image without pulling'
complete -c pl -n '__fish_seen_subcommand_from docker' -s q -l quiet -d 'Suppress PrairieLearn launcher output'
complete -c pl -n '__fish_seen_subcommand_from docker' -l image -a 'us-prod-live latest' -d 'PrairieLearn Docker image tag'
complete -c pl -n '__fish_seen_subcommand_from docker' -l start-docker -d 'Start the Docker daemon when unavailable'
complete -c pl -n '__fish_seen_subcommand_from docker' -a '(__fish_complete_directories)'

complete -c pl -n '__fish_seen_subcommand_from logs' -s f -l follow -d 'Continue streaming new log events'
complete -c pl -n '__fish_seen_subcommand_from logs' -l tail -r -d 'Number of recent events'
complete -c pl -n '__fish_seen_subcommand_from logs' -l stream -a 'all stdout stderr' -d 'Filter output stream'

complete -c pl -n '__fish_seen_subcommand_from backend' -a 'status stop'
