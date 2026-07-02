function __pl_seen_subcommand
    set -l cmd (commandline -opc)
    contains -- run $cmd; or contains -- docker $cmd
end

complete -c pl -f -n 'not __pl_seen_subcommand' -a run -d 'Launch PrairieLearn without opening the interactive launcher'
complete -c pl -f -n 'not __pl_seen_subcommand' -a docker -d 'Launch PrairieLearn from the Docker image'
complete -c pl -f -s q -l quiet -d 'Suppress PrairieLearn launcher output'

complete -c pl -n '__fish_seen_subcommand_from run' -s b -l branch -r -d 'Branch, remote branch, or ref to launch'
complete -c pl -n '__fish_seen_subcommand_from run' -s f -l force-rebuild -d 'Rebuild all dependencies before launch'
complete -c pl -n '__fish_seen_subcommand_from run' -s l -l local-only -d 'Skip git pull before launch'
complete -c pl -n '__fish_seen_subcommand_from run' -s p -l path -r -F -d 'PrairieLearn project checkout path'
complete -c pl -n '__fish_seen_subcommand_from run' -s q -l quiet -d 'Suppress PrairieLearn launcher output'
complete -c pl -n '__fish_seen_subcommand_from run' -s w -l no-watch-upstream -d 'Disable upstream polling and auto-restart'

complete -c pl -n '__fish_seen_subcommand_from docker' -l port -r -d 'Docker port mapping'
complete -c pl -n '__fish_seen_subcommand_from docker' -l tmp-dir -r -F -d 'Parent directory for temporary Docker jobs directories'
complete -c pl -n '__fish_seen_subcommand_from docker' -s l -l local-only -d 'Use the local Docker image without pulling'
complete -c pl -n '__fish_seen_subcommand_from docker' -s q -l quiet -d 'Suppress PrairieLearn launcher output'
complete -c pl -n '__fish_seen_subcommand_from docker' -a '(__fish_complete_directories)'
