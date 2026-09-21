#define _GNU_SOURCE
#include <errno.h>
#include <linux/fs.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

/* FDs 3 and 4 are held, already-authorized parent directories from Node. */
static int valid_leaf(const char *name) {
    return name[0] != '\0' && strchr(name, '/') == NULL &&
           strcmp(name, ".") != 0 && strcmp(name, "..") != 0;
}

int main(int argc, char **argv) {
    if (argc != 3 || !valid_leaf(argv[1]) || !valid_leaf(argv[2])) {
        printf("%d\n", EINVAL);
        return 1;
    }
#ifdef SYS_renameat2
    if (syscall(SYS_renameat2, 3, argv[1], 4, argv[2], RENAME_NOREPLACE) == 0) return 0;
    const int failure = errno;
#else
    const int failure = ENOSYS;
#endif
    printf("%d\n", failure);
    return 1;
}
