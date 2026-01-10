pipeline {
    agent {
        kubernetes {
            yaml '''
apiVersion: v1
kind: Pod
metadata:
  labels:
    jenkins: agent
spec:
  serviceAccountName: jenkins
  containers:
  - name: node
    image: node:18-alpine
    command:
    - cat
    tty: true
  - name: docker
    image: docker:dind
    command:
    - cat
    tty: true
    securityContext:
      privileged: true
    volumeMounts:
      - name: dind-storage
        mountPath: /var/lib/docker
  - name: trivy
    image: aquasec/trivy:latest
    command:
    - cat
    tty: true
  - name: helm
    image: alpine/helm:latest
    command:
    - cat
    tty: true
  - name: aws
    image: amazon/aws-cli:latest
    command:
    - cat
    tty: true
  volumes:
    - name: dind-storage
      emptyDir: {}
'''
        }
    }

    environment {
        // App Config
        APP_NAME = 'booking-service' // Change this per service
        AWS_REGION = 'us-east-1'
        ECR_REGISTRY = '173235558072.dkr.ecr.us-east-1.amazonaws.com'
        IMAGE_URI = "${ECR_REGISTRY}/ticket-booking/${APP_NAME}"
        
        // SonarQube Config
        SONAR_HOST_URL = 'https://sonarcloud.io'
        SONAR_ORG = 'test-booking-application' // Your SonarCloud Organization Key
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    // Capture Git Commit Hash for Tagging
                    env.GIT_COMMIT = sh(script: "git rev-parse --short HEAD", returnStdout: true).trim()
                    env.DOCKER_TAG = "${BUILD_NUMBER}-${env.GIT_COMMIT}"
                }
            }
        }

        stage('Install Dependencies') {
            steps {
                container('node') {
                    sh 'npm ci'
                }
            }
        }

        stage('Lint & Test') {
            steps {
                container('node') {
                    sh 'npm run lint'
                    sh 'npm test'
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                container('node') {
                    withCredentials([string(credentialsId: 'sonar-token', variable: 'SONAR_TOKEN')]) {
                        sh 'apk add --no-cache openjdk17-jre'
                        sh """
                            npx sonar-scanner \
                            -Dsonar.projectKey=${SONAR_ORG}_${APP_NAME} \
                            -Dsonar.organization=${SONAR_ORG} \
                            -Dsonar.sources=. \
                            -Dsonar.host.url=${SONAR_HOST_URL} \
                            -Dsonar.login=${SONAR_TOKEN}
                        """
                    }
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                container('docker') {
                    script {
                        // Start Docker daemon and wait for it to be ready
                        sh '''
                            dockerd-entrypoint.sh &
                            sleep 10
                            while ! docker info > /dev/null 2>&1; do
                                echo "Waiting for Docker daemon to start..."
                                sleep 2
                            done
                            echo "Docker daemon is ready"
                        '''
                        
                        // Login to Docker Hub to avoid rate limits
                        withCredentials([usernamePassword(credentialsId: 'dockerhub-creds', passwordVariable: 'DOCKER_PASSWORD', usernameVariable: 'DOCKER_USERNAME')]) {
                            sh '''
                                echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin || echo "⚠️ Docker Hub login failed, continuing with unauthenticated pulls"
                            '''
                        }
                        
                        sh "docker build -t ${IMAGE_URI}:${DOCKER_TAG} ."
                        sh "docker tag ${IMAGE_URI}:${DOCKER_TAG} ${IMAGE_URI}:latest"
                    }
                }
            }
        }

        stage('Security Scan (Trivy)') {
            steps {
                container('docker') {
                    script {
                        // Install Trivy in the docker container
                        sh '''
                            apk add --no-cache wget tar
                            wget -q https://github.com/aquasecurity/trivy/releases/download/v0.48.0/trivy_0.48.0_Linux-64bit.tar.gz
                            tar zxf trivy_0.48.0_Linux-64bit.tar.gz
                            mv trivy /usr/local/bin/
                            chmod +x /usr/local/bin/trivy
                        '''
                        
                        // Export Docker image to tarball to avoid Docker API version issues
                        sh "docker save ${IMAGE_URI}:${DOCKER_TAG} -o /tmp/image.tar"
                        
                        // Scan the tarball
                        sh "trivy image --input /tmp/image.tar --severity CRITICAL --exit-code 1 --no-progress"
                        sh "trivy image --input /tmp/image.tar --severity HIGH,CRITICAL --no-progress > trivy-report.txt"
                        
                        // Clean up
                        sh "rm /tmp/image.tar"
                    }
                }
            }
        }

        stage('Push to ECR') {
            steps {
                container('docker') {
                    withCredentials([usernamePassword(credentialsId: 'aws-ecr-creds', passwordVariable: 'ECR_PASSWORD', usernameVariable: 'ECR_USERNAME')]) {
                        script {
                            // Install AWS CLI in docker container
                            sh '''
                                apk add --no-cache python3 py3-pip
                                pip3 install --break-system-packages awscli
                            '''
                            
                            // Login to ECR
                            sh "aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}"
                            
                            // Push specific tag (always)
                            sh "docker push ${IMAGE_URI}:${DOCKER_TAG}"
                            
                            // Push 'latest' tag ONLY for main branch
                            if (env.BRANCH_NAME == 'main') {
                                echo "🚀 Pushing 'latest' tag for main branch"
                                sh "docker push ${IMAGE_URI}:latest"
                            } else {
                                echo "⚠️ Skipping 'latest' tag push for branch: ${env.BRANCH_NAME}"
                            }
                        }
                    }
                }
            }
        }

    }

    post {
        always {
            archiveArtifacts artifacts: 'trivy-report.txt', allowEmptyArchive: true
        }
        success {
            echo "✅ CI Pipeline succeeded! Built and pushed ${APP_NAME}:${DOCKER_TAG}"
            script {
                if (env.BRANCH_NAME == 'main') {
                    echo "🔄 Updating image tag in Git for ArgoCD..."
                    
                    withCredentials([usernamePassword(credentialsId: 'github-token', passwordVariable: 'GH_TOKEN', usernameVariable: 'GH_USER')]) {
                        sh """
                            cd charts/${APP_NAME}
                            git fetch origin main
                            git checkout -B main origin/main
                            sed -i 's/tag: .*/tag: ${DOCKER_TAG}/' values.yaml
                            git config user.email "jenkins@ci.local"
                            git config user.name "Jenkins CI"
                            git add values.yaml
                            git commit -m "chore: Update ${APP_NAME} image to ${DOCKER_TAG}" || true
                            git push https://\$GH_USER:\$GH_TOKEN@github.com/test-booking-application/${APP_NAME}.git HEAD:main
                        """
                    }
                    
                    echo "✅ Image tag updated in Git."
                    echo "🚀 Triggering ArgoCD deployment..."
                    
                    // Trigger ArgoCD sync
                    container('helm') {
                        sh """
                            # Install kubectl
                            apk add --no-cache curl
                            curl -LO "https://dl.k8s.io/release/\$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
                            chmod +x kubectl
                            mv kubectl /usr/local/bin/
                            
                            # Trigger hard refresh and sync
                            kubectl patch application ${APP_NAME} -n argocd --type merge -p '{"metadata": {"annotations": {"argocd.argoproj.io/refresh": "hard"}}}'
                            
                            # Wait for sync to complete (timeout 5 minutes)
                            echo "⏳ Waiting for ArgoCD to sync..."
                            for i in \$(seq 1 60); do
                                SYNC_STATUS=\$(kubectl get application ${APP_NAME} -n argocd -o jsonpath='{.status.sync.status}')
                                HEALTH_STATUS=\$(kubectl get application ${APP_NAME} -n argocd -o jsonpath='{.status.health.status}')
                                
                                echo "Sync: \$SYNC_STATUS | Health: \$HEALTH_STATUS"
                                
                                if [ "\$SYNC_STATUS" = "Synced" ] && [ "\$HEALTH_STATUS" = "Healthy" ]; then
                                    echo "✅ ArgoCD deployment successful!"
                                    exit 0
                                fi
                                
                                if [ "\$HEALTH_STATUS" = "Degraded" ]; then
                                    echo "❌ ArgoCD deployment failed - application is degraded"
                                    kubectl get application ${APP_NAME} -n argocd -o yaml
                                    exit 1
                                fi
                                
                                sleep 5
                            done
                            
                            echo "⚠️ Timeout waiting for ArgoCD sync"
                            kubectl get application ${APP_NAME} -n argocd -o yaml
                            exit 1
                        """
                    }
                }
            }
        }
        failure {
            echo "❌ CI Pipeline failed."
        }
    }
}
