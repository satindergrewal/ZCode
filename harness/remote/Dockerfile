# A base image, e.g. Ubuntu
FROM ubuntu:22.04

# Install openssh-server
RUN apt-get update && apt-get install -y openssh-server

# Create the sshd runtime directory
RUN mkdir /var/run/sshd

# Set the root password and allow root password login (test only)
RUN echo 'root:root' | chpasswd
RUN sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config

# Create the dev user
RUN useradd -m -s /bin/bash dev && echo 'dev:dev' | chpasswd

# Keep env vars intact so ssh login does not error
RUN sed -i 's@session\s*required\s*pam_loginuid.so@session optional pam_loginuid.so@g' /etc/pam.d/sshd

# Expose the default ssh port
EXPOSE 22

# Start sshd
CMD ["/usr/sbin/sshd", "-D"]
